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

type ChatApi = Pick<
  ApiClient,
  "createConversation" | "sendMessage" | "commitConversation" | "resumeConversation"
>;
export class SessionError extends Error {}

/** 只控制 HTTP 会话生命周期；失败不重试，防止一次输入重复写入 Evidence。 */
export class ChatSession {
  private conversation: ChatConversation | undefined;
  private pending: Promise<unknown> | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private inherited: ConversationMessage[] = [];

  constructor(
    private readonly api: ChatApi,
    readonly projectId: string,
  ) {
    this.projectId = projectId.toLowerCase();
  }
  get id(): string | null {
    return this.conversation?.id ?? null;
  }
  get history(): readonly ConversationMessage[] {
    return this.inherited;
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
      this.conversation = row;
    }
    return this.conversation;
  }
  private async commit(): Promise<void> {
    if (!this.conversation) return;
    try {
      const row = ChatCommitSchema.parse(await this.api.commitConversation(this.conversation.id));
      if (row.id !== this.conversation.id || row.project_id !== this.projectId || !row.ended_at) {
        throw new SessionError("服务端未确认当前会话提交");
      }
    } catch (error) {
      // 此接口的 409 仅表示已结束；上次提交响应丢失时，显式重试可继续 /new 或退出。
      if (error instanceof ApiError && error.status === 409) return;
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
      this.conversation = row;
      this.inherited = row.messages;
      return row;
    });
  }
  async send(text: string): Promise<ChatReply> {
    if (!text.trim() || text.length > 8000) throw new SessionError("消息不能为空或超过 8000 字符");
    return this.run(async () => {
      const row = await this.ensureConversation();
      return ChatReplySchema.parse(await this.api.sendMessage(row.id, text));
    });
  }
  newConversation(): Promise<ChatConversation> {
    return this.run(async () => {
      await this.commit();
      this.conversation = undefined;
      this.inherited = [];
      return this.ensureConversation();
    });
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      // Ctrl+C 也先等待发消息完成，避免 commit 与正在写入的消息竞态。
      await this.pending?.catch(() => {});
      await this.commit();
      this.closed = true;
    })();
    return this.closing;
  }
}
