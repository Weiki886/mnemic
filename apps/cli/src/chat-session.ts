import {
  ApiError,
  type ApiClient,
  type ChatConversation,
  type ChatReply,
  type ConversationMessage,
} from "@mnemic/shared";
import {
  ChatConversationSchema,
  ChatReplySchema,
  ChatCommitSchema,
  ChatResumeSchema,
} from "@mnemic/shared/chat";
import {
  consumeChatStream,
  ChatStreamCancelSchema,
  ChatStreamReadError,
  type ChatStreamEvent,
} from "@mnemic/shared/chat-stream";

type ChatApi = Pick<
  ApiClient,
  "createConversation" | "sendMessage" | "commitConversation" | "resumeConversation"
> &
  Partial<Pick<ApiClient, "openMessageStream" | "cancelMessageStream" | "getConversation">>;
export class SessionError extends Error {}
/** Persistence confirmation is independent of whether the whole reply reached the terminal. */
export class SessionStreamError extends ChatStreamReadError {
  constructor(
    error: ChatStreamReadError,
    readonly saved: boolean,
  ) {
    super(error.code, error.progress);
  }
}
interface ActiveTurn {
  controller: AbortController;
  generationId?: string;
  requested: boolean;
  cancellation?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  confirmed: boolean;
}
export type SessionReply = ChatReply & { generation_status?: "complete" | "interrupted" };

/** 只控制 HTTP 会话生命周期；失败不重试，防止一次输入重复写入 Evidence。 */
export class ChatSession {
  private conversation: ChatConversation | undefined;
  private pending: Promise<unknown> | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private inherited: ConversationMessage[] = [];
  private active: ActiveTurn | undefined;
  private uncertain = false;
  private identityListeners = new Set<(id: string | null) => void>();

  constructor(
    private readonly api: ChatApi,
    readonly projectId: string,
  ) {
    this.projectId = projectId.toLowerCase();
  }
  get id(): string | null {
    return this.conversation?.id ?? null;
  }
  /** Synchronous boundary notification, including failed transitions before another send can run. */
  subscribeIdentity(listener: (id: string | null) => void): () => void {
    this.identityListeners.add(listener);
    listener(this.id);
    return () => {
      this.identityListeners.delete(listener);
    };
  }
  private setConversation(row: ChatConversation | undefined) {
    this.conversation = row;
    for (const listener of this.identityListeners) listener(this.id);
  }
  get history(): readonly ConversationMessage[] {
    return this.inherited;
  }
  get generating(): boolean {
    return this.active !== undefined;
  }
  /** Do not abort the reader until the server has had a chance to save and acknowledge. */
  interrupt(): void {
    const turn = this.active;
    if (!turn || turn.requested) return;
    turn.requested = true;
    turn.timer = setTimeout(() => turn.controller.abort(), 10_000);
    this.cancelTurn(turn);
  }
  private cancelTurn(turn: ActiveTurn): void {
    if (!turn.requested || !turn.generationId || turn.cancellation) return;
    const id = turn.generationId;
    turn.cancellation = (async () => {
      try {
        const receipt = ChatStreamCancelSchema.parse(
          await this.api.cancelMessageStream!(this.projectId, this.id!, id),
        );
        if (receipt.generation_id !== id || receipt.message_id !== id)
          throw new Error("mismatched acknowledgement");
        turn.confirmed = true;
      } catch {
        turn.controller.abort();
      }
    })();
  }
  private requireConfirmed(): void {
    if (this.uncertain)
      throw new SessionError(
        "上一轮保存未确认；请先 /resume 当前会话 ID 核对服务端历史，不会自动重发或提交",
      );
  }

  private async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.pending || this.closing || this.closed)
      throw new SessionError("会话正在处理或已退出，请等待当前操作结束");
    const pending = job();
    this.pending = pending;
    try {
      return await pending;
    } finally {
      this.pending = undefined;
    }
  }
  private async ensureConversation(): Promise<ChatConversation> {
    if (!this.conversation) {
      const row = ChatConversationSchema.parse(await this.api.createConversation(this.projectId));
      if (row.project_id !== this.projectId || row.ended_at !== null)
        throw new SessionError("服务端会话与项目不匹配或已提交");
      this.setConversation(row);
      return row;
    }
    return this.conversation;
  }
  private async commit(): Promise<void> {
    this.requireConfirmed();
    if (!this.conversation) return;
    try {
      const row = ChatCommitSchema.parse(await this.api.commitConversation(this.conversation.id));
      if (row.id !== this.conversation.id || row.project_id !== this.projectId || !row.ended_at) {
        throw new SessionError("服务端未确认当前会话提交");
      }
    } catch (error) {
      // 409 can also mean an active stream. Only a scoped read can confirm an earlier commit.
      if (error instanceof ApiError && error.status === 409 && this.api.getConversation) {
        const row = ChatConversationSchema.parse(
          await this.api.getConversation(this.projectId, this.conversation.id),
        );
        if (row.id === this.conversation.id && row.project_id === this.projectId && row.ended_at)
          return;
      }
      throw error;
    }
  }
  start(): Promise<ChatConversation> {
    return this.run(() => this.ensureConversation());
  }
  resume(sourceId: string): Promise<ChatConversation> {
    const parsed = ChatConversationSchema.shape.id.safeParse(sourceId);
    if (!parsed.success) return Promise.reject(new SessionError("恢复参数非法：请提供会话 UUID"));
    const id = parsed.data.toLowerCase();
    return this.run(async () => {
      const row = ChatResumeSchema.parse(
        await this.api.resumeConversation(this.projectId, id, this.conversation?.id),
      );
      if (
        row.project_id !== this.projectId ||
        row.resumed_from !== id ||
        row.ended_at !== null ||
        row.id === id ||
        row.id === this.id
      )
        throw new SessionError("服务端未确认项目内的新续聊会话");
      this.setConversation(row);
      this.inherited = row.messages;
      this.uncertain = false;
      return row;
    });
  }
  async send(text: string, onEvent?: (event: ChatStreamEvent) => void): Promise<SessionReply> {
    if (!text.trim() || text.length > 8000) throw new SessionError("消息不能为空或超过 8000 字符");
    return this.run(async () => {
      this.requireConfirmed();
      // Legacy embedding adapters may expose JSON only; HTTP stream errors never fall back or replay.
      if (onEvent && this.api.openMessageStream && this.api.cancelMessageStream) {
        const turn: ActiveTurn = {
          controller: new AbortController(),
          requested: false,
          confirmed: false,
        };
        this.active = turn;
        let sending = false;
        try {
          const row = await this.ensureConversation();
          turn.controller.signal.throwIfAborted();
          sending = true;
          const response = await this.api.openMessageStream(
            this.projectId,
            row.id,
            text,
            turn.controller.signal,
          );
          const result = await consumeChatStream(response, {
            conversationId: row.id,
            signal: turn.controller.signal,
            timeoutMs: 600_000,
            onEvent: (event) => {
              if (event.type === "start") {
                turn.generationId = event.generation_id;
                this.cancelTurn(turn);
              }
              onEvent(event);
            },
          });
          if (result.reply.message_id !== result.generationId)
            throw new ChatStreamReadError("INVALID_STREAM", { answer: result.reply.answer });
          return { ...result.reply, generation_status: result.status };
        } catch (error) {
          const savedFinish =
            error instanceof ChatStreamReadError &&
            error.progress.terminal?.type === "finish" &&
            error.progress.terminal.message_id === error.progress.generationId;
          const savedFailure =
            error instanceof ChatStreamReadError &&
            error.progress.terminal?.type === "error" &&
            error.progress.terminal.code === "GENERATION_FAILED";
          const saved = turn.confirmed || savedFinish || savedFailure;
          this.uncertain =
            sending &&
            !(saved || (error instanceof ApiError && error.status >= 400 && error.status < 500));
          if (error instanceof ChatStreamReadError) throw new SessionStreamError(error, saved);
          throw error;
        } finally {
          if (turn.timer) clearTimeout(turn.timer);
          this.active = undefined;
        }
      }
      const row = await this.ensureConversation();
      return ChatReplySchema.parse(await this.api.sendMessage(row.id, text));
    });
  }
  newConversation(): Promise<ChatConversation> {
    return this.run(async () => {
      await this.commit();
      this.setConversation(undefined);
      this.inherited = [];
      return this.ensureConversation();
    });
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      // Ctrl+C 也先等待发消息完成，避免 commit 与正在写入的消息竞态。
      await this.pending?.catch(() => {});
      if (this.uncertain && this.id)
        throw new SessionError(
          `上一轮保存未确认，不会自动重发或提交。退出后沿用原服务端地址和鉴权配置，在终端运行：\nmnemic resume ${this.id} --project ${this.projectId}`,
        );
      await this.commit();
      this.closed = true;
    })();
    return this.closing;
  }
}
