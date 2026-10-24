import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { parse } from "node:path";
import {
  ApprovalContextSchema,
  ApprovalModeSchema,
  ApprovalOperationSchema,
  type ApprovalEvaluation,
  type ApprovalOperation,
  type ApprovalScope,
  type ReusableApprovalGrant,
} from "@mnemic/shared/approval";
import { evaluateApproval } from "./approval-policy.js";
import { ApprovalStore, type StoredApproval } from "./approval-store.js";
import { ApprovalAuditEventSchema, type ApprovalAuditSink } from "@mnemic/shared/approval-audit";

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
  scope?: ApprovalScope;
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
  private requests = new Set<Promise<ApprovalResult>>();
  private answers = new Set<Promise<boolean>>();
  private newGrant: { id: string; scope: "session" | "permanent" } | null = null;
  private preparedGrant: ReusableApprovalGrant | null = null;
  private auditFailure = false;

  private constructor(
    ctx: ApprovalController["ctx"],
    private store: ApprovalStore,
    private audit: ApprovalAuditSink,
  ) {
    this.ctx = ctx;
  }
  static async create(options: {
    projectId: string;
    root: string;
    mode?: string;
    store?: ApprovalStore;
    audit: ApprovalAuditSink;
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
    if (typeof options.audit !== "function") throw new Error("审批审计写入器未配置。");
    return new ApprovalController(ctx, options.store ?? new ApprovalStore(), options.audit);
  }
  get mode() {
    return this.ctx.mode;
  }
  get root() {
    return this.ctx.root;
  }
  get storageDirectory() {
    return this.store.directory;
  }
  get busy() {
    return this.active;
  }
  get auditFailed() {
    return this.auditFailure;
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.requests, ...this.answers]);
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
  cancelRequest(): void {
    this.cancel();
    this.emit();
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
  request(input: unknown): Promise<ApprovalResult> {
    const task = this.auditedRequest(input);
    this.requests.add(task);
    void task.then(
      () => this.requests.delete(task),
      () => this.requests.delete(task),
    );
    return task;
  }
  private async undoGrant() {
    const grant = this.newGrant;
    this.newGrant = null;
    if (!grant) return;
    if (grant.scope === "session")
      this.sessionGrants = this.sessionGrants.filter((row) => row.id !== grant.id);
    else await this.store.remove(grant.id);
  }
  private async auditedRequest(input: unknown): Promise<ApprovalResult> {
    const ctx = { ...this.ctx },
      epoch = this.epoch,
      owns = !this.closed && !this.active;
    if (owns) this.active = true;
    try {
      const result = this.closed
        ? { approved: false, reason: "closed" }
        : owns
          ? await this.decide(input)
          : { approved: false, reason: "busy" };
      const parsed = ApprovalOperationSchema.safeParse(input);
      const evaluation = result.evaluation;
      const canonical = evaluation && "target" in evaluation ? evaluation : null;
      const operation = canonical?.operation ?? (parsed.success ? parsed.data.kind : null);
      const target =
        canonical?.target ??
        (parsed.success
          ? parsed.data.kind === "shell"
            ? parsed.data.cwd
            : parsed.data.target
          : null);
      const digest = (value: string) => createHash("sha256").update(value).digest("hex");
      const event = ApprovalAuditEventSchema.parse({
        event_id: randomUUID(),
        request_id: randomUUID(),
        project_id: ctx.project_id,
        session_id: ctx.session_id,
        mode: ctx.mode,
        operation,
        decision: result.approved ? "allow" : "deny",
        reason: result.reason,
        ...(result.scope ? { scope: result.scope } : {}),
        root_hash: digest(ctx.root),
        target_hash: target === null ? null : digest(target),
        target_basis: target === null ? "none" : canonical ? "canonical" : "requested",
        ...(parsed.success && parsed.data.kind === "shell"
          ? { command_hash: digest(parsed.data.command) }
          : {}),
      });
      await this.audit(Object.freeze(event));
      const denyAfterAudit = async (
        reason: "changed" | "cancelled" | "storage_error",
      ): Promise<ApprovalResult> => {
        await this.undoGrant().catch(() => {});
        await this.audit(
          Object.freeze(
            ApprovalAuditEventSchema.parse({
              ...event,
              event_id: randomUUID(),
              decision: "deny",
              reason,
              scope: undefined,
            }),
          ),
        );
        return { approved: false, reason };
      };
      if (owns && result.approved && canonical && parsed.success) {
        const recheck = async (): Promise<"changed" | "cancelled" | null> => {
          if (epoch !== this.epoch || this.closed) return "cancelled";
          const current = await this.assess(parsed.data);
          if (epoch !== this.epoch || this.closed) return "cancelled";
          return current.decision === "deny" ||
            current.operation !== canonical.operation ||
            current.target !== canonical.target ||
            (result.reason !== "confirmed" && current.decision !== "allow")
            ? "changed"
            : null;
        };
        let rejection: "changed" | "cancelled" | "storage_error" | null = null;
        try {
          rejection = await recheck();
          if (!rejection && this.preparedGrant) {
            const grant = this.preparedGrant;
            const id = grant.scope === "permanent" ? await this.store.add(grant) : randomUUID();
            this.newGrant = { id, scope: grant.scope };
            if (grant.scope === "session") this.sessionGrants.push({ id, grant });
            rejection = await recheck();
          }
        } catch {
          rejection = "storage_error";
        }
        if (rejection) return await denyAfterAudit(rejection);
      }
      if (owns) this.newGrant = null;
      return result;
    } catch {
      this.auditFailure = true;
      if (owns) await this.undoGrant().catch(() => {});
      return { approved: false, reason: "audit_error" };
    } finally {
      if (owns) {
        await Promise.allSettled([...this.answers]);
        this.preparedGrant = null;
        this.active = false;
        this.emit();
      }
    }
  }
  private async decide(input: unknown): Promise<ApprovalResult> {
    const parsed = ApprovalOperationSchema.safeParse(input);
    if (!parsed.success) return { approved: false, reason: "invalid_request" };
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
    }
  }
  /** Call only for an explicit local human action; never expose this method to model/HTTP inputs. */
  answer(id: string, choice: ApprovalScope | "deny"): Promise<boolean> {
    const task = this.decideAnswer(id, choice);
    this.answers.add(task);
    void task.then(
      () => this.answers.delete(task),
      () => this.answers.delete(task),
    );
    return task;
  }
  private async decideAnswer(id: string, choice: ApprovalScope | "deny"): Promise<boolean> {
    const waiting = this.waiting;
    if (!waiting || waiting.prompt.id !== id || waiting.prompt.answering) return false;
    if (choice === "deny") {
      this.finish(waiting, { approved: false, reason: "denied" });
      return true;
    }
    if (!waiting.prompt.evaluation.allowed_scopes.includes(choice)) return false;
    waiting.prompt.answering = true;
    this.emit();
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
      if (choice === "session")
        this.preparedGrant = { ...fields, scope: "session", session_id: this.ctx.session_id };
      if (choice === "permanent") this.preparedGrant = { ...fields, scope: "permanent" };
      this.finish(waiting, {
        approved: true,
        reason: "confirmed",
        evaluation: current,
        scope: choice,
      });
    } catch {
      this.finish(waiting, { approved: false, reason: "storage_error" });
    }
    return true;
  }
}
