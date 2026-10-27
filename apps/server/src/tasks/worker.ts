import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import {
  assertTaskScope,
  claimTasks,
  completeTask,
  retryTask,
  renewTaskLease,
  type ClaimedTask,
  type TaskLease,
  type TaskRow,
} from "./repository.js";
import { createPeriodicScheduler, parseTaskSchedules, type TaskSchedule } from "./scheduler.js";
export type TaskHandler = (
  task: Readonly<ClaimedTask>,
  context: { signal: AbortSignal },
) => Promise<void>;
export interface WorkerOptions {
  db: PostgresJsDatabase;
  handlers: Partial<Record<TaskRow["type"], TaskHandler>>;
  projectId?: string;
  concurrency?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
  taskTimeoutMs?: number;
  schedules?: TaskSchedule[];
  logger?: { warn(message: string): void };
}
const Settings = z
  .object({
    projectId: z.string().uuid().toLowerCase().optional(),
    concurrency: z.number().int().min(1).max(32).default(2),
    leaseMs: z.number().int().min(100).max(300000).default(30000),
    heartbeatMs: z.number().int().min(1).optional(),
    pollMs: z.number().int().min(10).max(60000).default(1000),
    taskTimeoutMs: z.number().int().min(10).max(3600000).default(300000),
  })
  .strict();
type Active = {
  controller: AbortController;
  promise: Promise<void>;
  live: boolean;
  lost: boolean;
  timedOut: boolean;
  heartbeat?: NodeJS.Timeout | undefined;
  deadline?: NodeJS.Timeout | undefined;
  renewal?: Promise<void> | undefined;
};

/** Single-process worker. Only registered handlers are claimable; promises are never treated as cancelled work. */
export class TaskWorker {
  private readonly db: PostgresJsDatabase;
  private readonly settings: z.infer<typeof Settings> & { heartbeatMs: number };
  private readonly handlers: Map<TaskRow["type"], TaskHandler>;
  private readonly schedule: (signal?: AbortSignal) => Promise<number>;
  private readonly scheduleAbort = new AbortController();
  private readonly logger: WorkerOptions["logger"];
  private readonly active = new Map<string, Active>();
  private polling: Promise<number> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private stopping = false;
  private abandoned = false;
  private stopExpiresAt: number | undefined;
  private stopped: Promise<{ drained: boolean }> | undefined;
  constructor(options: WorkerOptions) {
    const { db, handlers, schedules = [], logger, ...raw } = options;
    const settings = Settings.parse(raw),
      heartbeatMs = settings.heartbeatMs ?? Math.floor(settings.leaseMs / 3);
    if (heartbeatMs * 2 >= settings.leaseMs) throw Error("invalid worker heartbeat");
    const entries = Object.entries(handlers);
    if (
      !entries.length ||
      entries.some(
        ([type, handler]) =>
          !["EXTRACT", "REEMBED", "DECAY", "COMPILE_PROFILE"].includes(type) ||
          typeof handler !== "function",
      )
    )
      throw Error("invalid task handlers");
    // Validate and snapshot schedules without relying on caller-owned objects during future ticks.
    const registered = new Map(entries as [TaskRow["type"], TaskHandler][]);
    const planned = parseTaskSchedules(schedules);
    if (
      planned.some(
        (p) =>
          !registered.has("COMPILE_PROFILE") ||
          (settings.projectId && p.projectId !== settings.projectId),
      )
    )
      throw Error("unhandled task schedule");
    this.db = db;
    this.handlers = registered;
    this.settings = { ...settings, heartbeatMs };
    this.logger = logger;
    this.schedule = createPeriodicScheduler(db, schedules, () =>
      this.warn("task schedule enqueue failed"),
    );
  }
  private warn(message: string) {
    try {
      this.logger?.warn(message);
    } catch {
      /* No raw error fallback. */
    }
  }
  tick(): Promise<number> {
    if (this.stopping) return Promise.resolve(0);
    this.polling ??= this.fill().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }
  private async fill(): Promise<number> {
    await this.schedule(this.scheduleAbort.signal);
    if (this.stopping) return 0;
    const slots = this.settings.concurrency - this.active.size;
    if (slots <= 0) return 0;
    const tasks = await claimTasks(this.db, {
      ...(this.settings.projectId ? { projectId: this.settings.projectId } : {}),
      types: [...this.handlers.keys()],
      excludeTaskIds: [...this.active.keys()],
      limit: slots,
      leaseMs: this.settings.leaseMs,
    });
    // A stop deadline can expire while SQL is in flight. Never start/ack abandoned claims.
    if (this.stopExpired()) return 0;
    let started = 0;
    for (const task of tasks) {
      if (this.stopExpired()) break;
      started++;
      const entry: Active = {
        controller: new AbortController(),
        promise: Promise.resolve(),
        live: true,
        lost: false,
        timedOut: false,
      };
      this.active.set(task.id, entry);
      entry.promise = this.execute(task, entry)
        .catch(() => this.warn("task worker persistence failed"))
        .finally(() => {
          if (this.active.get(task.id) === entry) this.active.delete(task.id);
        });
    }
    return started;
  }
  private clearTimers(entry: Active) {
    if (entry.heartbeat) clearTimeout(entry.heartbeat);
    if (entry.deadline) clearTimeout(entry.deadline);
  }
  private abandon(): void {
    if (this.abandoned) return;
    this.abandoned = true;
    for (const entry of this.active.values()) {
      this.clearTimers(entry);
      entry.controller.abort();
    }
  }
  private stopExpired(): boolean {
    if (this.stopExpiresAt !== undefined && performance.now() >= this.stopExpiresAt) this.abandon();
    return this.abandoned;
  }
  private heartbeat(entry: Active, lease: TaskLease, checkDeadline: () => void) {
    if (!entry.live) return;
    checkDeadline();
    if (this.stopExpired() || entry.controller.signal.aborted) return;
    entry.heartbeat = setTimeout(() => {
      if (!entry.live) return;
      checkDeadline();
      if (this.stopExpired() || entry.controller.signal.aborted) return;
      entry.renewal = renewTaskLease(this.db, lease, this.settings.leaseMs)
        .then((ok) => {
          if (!ok) {
            entry.lost = true;
            entry.controller.abort();
          }
        })
        .catch(() => {
          entry.lost = true;
          entry.controller.abort();
          this.warn("task worker lease unavailable");
        })
        .finally(() => {
          entry.renewal = undefined;
          this.heartbeat(entry, lease, checkDeadline);
        });
    }, this.settings.heartbeatMs);
    entry.heartbeat.unref();
  }
  private async execute(task: ClaimedTask, entry: Active): Promise<void> {
    const lease = { id: task.id, projectId: task.projectId, leaseToken: task.leaseToken };
    const handler = this.handlers.get(task.type)!;
    const expiresAt = performance.now() + this.settings.taskTimeoutMs;
    const expire = () => {
      entry.timedOut = true;
      entry.controller.abort();
      if (entry.heartbeat) clearTimeout(entry.heartbeat);
    };
    const checkDeadline = () => {
      if (!entry.timedOut && performance.now() >= expiresAt) expire();
    };
    entry.deadline = setTimeout(expire, this.settings.taskTimeoutMs);
    entry.deadline.unref();
    this.heartbeat(entry, lease, checkDeadline);
    let failed = false;
    try {
      if (this.stopExpired()) return;
      await assertTaskScope(this.db, task);
      this.stopExpired();
      checkDeadline();
      entry.controller.signal.throwIfAborted();
      await handler(structuredClone(task), { signal: entry.controller.signal });
    } catch {
      failed = true;
    } finally {
      // CPU work or a continuous microtask chain can prevent the timer from running at all.
      checkDeadline();
      entry.live = false;
      this.clearTimers(entry);
      await entry.renewal;
    }
    if (this.stopExpired() || entry.lost) return;
    if (entry.timedOut) await retryTask(this.db, lease, "TIMEOUT");
    else if (failed) {
      this.warn("task handler failed");
      await retryTask(this.db, lease, "HANDLER_FAILED");
    } else await completeTask(this.db, lease);
  }
  start(): void {
    if (this.stopping) throw Error("task worker already stopped");
    if (this.started) return;
    this.started = true;
    const poll = () => {
      void this.tick()
        .catch(() => this.warn("task worker poll failed"))
        .finally(() => {
          if (!this.stopping) {
            this.timer = setTimeout(poll, this.settings.pollMs);
            this.timer.unref();
          }
        });
    };
    poll();
  }
  stop(timeoutMs = 10000): Promise<{ drained: boolean }> {
    const deadline = z.number().int().min(0).max(60000).parse(timeoutMs);
    if (this.stopped) return this.stopped;
    this.stopping = true;
    this.scheduleAbort.abort();
    if (this.timer) clearTimeout(this.timer);
    if (!this.polling && this.active.size === 0)
      return (this.stopped = Promise.resolve({ drained: true }));
    this.stopExpiresAt = performance.now() + deadline;
    const drain = async () => {
      while (this.polling || this.active.size) {
        if (this.polling) await this.polling.catch(() => {});
        await Promise.all([...this.active.values()].map((e) => e.promise));
      }
      return true;
    };
    this.stopped = (async () => {
      let timer: NodeJS.Timeout | undefined;
      const finished = await Promise.race([
        drain(),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), deadline);
        }),
      ]);
      if (timer) clearTimeout(timer);
      const drained = finished && !this.stopExpired();
      if (!drained) this.abandon();
      return { drained };
    })();
    return this.stopped;
  }
}
