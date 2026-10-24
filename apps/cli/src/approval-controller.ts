import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { parse } from "node:path";
import {
  ApprovalContextSchema,
  ApprovalModeSchema,
  ApprovalOperationSchema,
  type ApprovalEvaluation,
  type ApprovalOperation,
  type ApprovalScope,
} from "@mnemic/shared/approval";
import { evaluateApproval } from "./approval-policy.js";
import { ApprovalStore, type StoredApproval } from "./approval-store.js";

type Ask = Extract<ApprovalEvaluation, { decision: "ask" }>;
export interface ApprovalPrompt {
  id: string;
  evaluation: Ask;
  command?: string;
  answering: boolean;
}
export interface ApprovalResult {
  approved: boolean;
  reason: string;
  evaluation?: ApprovalEvaluation;
}
interface Waiting {
  prompt: ApprovalPrompt;
  operation: ApprovalOperation;
  epoch: number;
  resolve: (result: ApprovalResult) => void;
}

/** Trusted local human/controller boundary. A result is NOT an executable capability. */
export class ApprovalController {
  private ctx: ReturnType<typeof ApprovalContextSchema.parse>;
  private waiting: Waiting | null = null;
  private active = false;
  private closed = false;
  private epoch = 0;
  private sessionGrants: StoredApproval[] = [];
  private listeners = new Set<() => void>();

  private constructor(
    ctx: ApprovalController["ctx"],
    private store: ApprovalStore,
  ) {
    this.ctx = ctx;
  }
  static async create(options: {
    projectId: string;
    root: string;
    mode?: string;
    store?: ApprovalStore;
  }) {
    const root = await realpath(options.root);
    if (root === parse(root).root || !(await stat(root)).isDirectory())
      throw new Error("项目根目录无效。");
    const ctx = ApprovalContextSchema.parse({
      project_id: options.projectId,
      session_id: randomUUID(),
      root,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    return new ApprovalController(ctx, options.store ?? new ApprovalStore());
  }
  get mode() {
    return this.ctx.mode;
  }
  get root() {
    return this.ctx.root;
  }
  get busy() {
    return this.active;
  }
  get pending(): ApprovalPrompt | null {
    return this.waiting ? structuredClone(this.waiting.prompt) : null;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit() {
    for (const listener of this.listeners) listener();
  }
  private finish(waiting: Waiting, result: ApprovalResult) {
    if (this.waiting !== waiting) return;
    this.waiting = null;
    waiting.resolve(result);
    this.emit();
  }
  private cancel() {
    this.epoch++;
    if (this.waiting) this.finish(this.waiting, { approved: false, reason: "cancelled" });
  }
  setMode(mode: string) {
    const parsed = ApprovalModeSchema.parse(mode);
    this.cancel();
    this.ctx.mode = parsed;
    this.emit();
  }
  setSession(id: string | null) {
    const ctx = ApprovalContextSchema.parse({ ...this.ctx, session_id: id ?? randomUUID() });
    if (ctx.session_id === this.ctx.session_id) return;
    this.cancel();
    this.ctx = ctx;
    this.sessionGrants = [];
    this.emit();
  }
  dispose() {
    this.closed = true;
    this.cancel();
    this.sessionGrants = [];
    this.listeners.clear();
  }
  async list(): Promise<StoredApproval[]> {
    return structuredClone(
      [...this.sessionGrants, ...(await this.store.list())].filter(
        (row) => row.grant.project_id === this.ctx.project_id && row.grant.root === this.ctx.root,
      ),
    );
  }
  async revoke(id: string): Promise<boolean> {
    const row = (await this.list()).find((row) => row.id === id);
    if (!row) return false;
    this.cancel();
    if (row.grant.scope === "session")
      this.sessionGrants = this.sessionGrants.filter((row) => row.id !== id);
    else await this.store.remove(id);
    this.emit();
    return true;
  }
  private async assess(operation: ApprovalOperation) {
    const grants = (await this.list()).map((row) => row.grant);
    return evaluateApproval({ ...this.ctx, grants }, operation);
  }
  async request(input: unknown): Promise<ApprovalResult> {
    if (this.closed) return { approved: false, reason: "closed" };
    if (this.active) return { approved: false, reason: "busy" };
    const parsed = ApprovalOperationSchema.safeParse(input);
    if (!parsed.success) return { approved: false, reason: "invalid_request" };
    this.active = true;
    const epoch = this.epoch;
    try {
      const evaluation = await this.assess(parsed.data);
      if (epoch !== this.epoch || this.closed) return { approved: false, reason: "cancelled" };
      if (evaluation.decision !== "ask")
        return {
          approved: evaluation.decision === "allow",
          reason: evaluation.reason,
          evaluation,
        };
      return await new Promise<ApprovalResult>((resolve) => {
        this.waiting = {
          prompt: {
            id: randomUUID(),
            evaluation,
            answering: false,
            ...(parsed.data.kind === "shell" ? { command: parsed.data.command } : {}),
          },
          operation: parsed.data,
          epoch,
          resolve,
        };
        this.emit();
      });
    } catch {
      return { approved: false, reason: "storage_error" };
    } finally {
      this.active = false;
      this.emit();
    }
  }
  /** Call only for an explicit local human action; never expose this method to model/HTTP inputs. */
  async answer(id: string, choice: ApprovalScope | "deny"): Promise<boolean> {
    const waiting = this.waiting;
    if (!waiting || waiting.prompt.id !== id || waiting.prompt.answering) return false;
    if (choice === "deny") {
      this.finish(waiting, { approved: false, reason: "denied" });
      return true;
    }
    if (!waiting.prompt.evaluation.allowed_scopes.includes(choice)) return false;
    waiting.prompt.answering = true;
    this.emit();
    let saved: string | undefined;
    try {
      const current = await this.assess(waiting.operation),
        original = waiting.prompt.evaluation;
      if (
        this.waiting !== waiting ||
        waiting.epoch !== this.epoch ||
        current.decision !== "ask" ||
        current.operation !== original.operation ||
        current.target !== original.target ||
        !current.allowed_scopes.includes(choice)
      ) {
        this.finish(waiting, { approved: false, reason: "changed" });
        return true;
      }
      const fields = {
        project_id: this.ctx.project_id,
        root: this.ctx.root,
        target: current.target,
        operation: "file.create" as const,
      };
      if (choice === "permanent") saved = await this.store.add({ ...fields, scope: "permanent" });
      if (saved) {
        const afterSave = await this.assess(waiting.operation);
        if (
          afterSave.decision === "deny" ||
          afterSave.operation !== original.operation ||
          afterSave.target !== original.target
        ) {
          await this.store.remove(saved);
          this.finish(waiting, { approved: false, reason: "changed" });
          return true;
        }
      }
      if (this.waiting !== waiting || waiting.epoch !== this.epoch) {
        if (saved) await this.store.remove(saved);
        return true;
      }
      if (choice === "session")
        this.sessionGrants.push({
          id: randomUUID(),
          grant: { ...fields, scope: "session", session_id: this.ctx.session_id },
        });
      this.finish(waiting, { approved: true, reason: "confirmed", evaluation: current });
    } catch {
      if (saved) await this.store.remove(saved).catch(() => {});
      this.finish(waiting, { approved: false, reason: "storage_error" });
    }
    return true;
  }
}
