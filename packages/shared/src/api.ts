/** 类型化 API client（#8）：Web 记忆中心经 packages/shared 调 server API。
 *  - 键名与 server 响应保持一致：读路由为 snake_case，resolutions 为 drizzle 直出的 camelCase。
 *  - 错误统一转 ApiError：problem+json → 结构化字段；非 problem 体 → status + 原始文本。
 *  - fetch 可注入（默认全局 fetch），便于单测与非浏览器环境。 */

import type { ErrorCode, FieldError } from "./errors.js";
import type {
  ApprovalAuditEvent,
  ApprovalAuditRecord,
  ApprovalAuditPage,
  ApprovalAuditQuery,
} from "./approval-audit.js";
import type { DoctorReport } from "./doctor.js";
import type { ChatStreamCancel } from "./stream-protocol.js";
import type { BeliefListItem, MemoryListQuery, RecallResult } from "./memory.js";
import type { ServerConfig, ProjectStatus, ProviderPatch, ProviderConfig } from "./management.js";
export type { BeliefListItem } from "./memory.js";
import type {
  ChatConversation,
  ChatCommit,
  ChatReply,
  ChatResume,
  ConversationListItem,
  ConversationMessage,
} from "./chat.js";
export type { ConversationListItem, CitedMemory, ConversationMessage } from "./chat.js";

/* ---------- 响应类型（与 apps/server 路由返回结构对齐） ---------- */
// 评分的 HTTP 契约为 JSON number | null（#68）；数据库 numeric 字符串由 server 在返回层转换。

export interface BeliefVersionItem {
  id: string;
  value: unknown;
  valid_from: string | null;
  valid_to: string | null;
  recorded_from: string;
  recorded_to: string | null;
  supersedes_version_id: string | null;
  confidence: number | null;
  resolver_version: string | null;
  source: { observation_id: string; message_id: string; conversation_id: string } | null;
}

export interface BeliefDetail {
  id: string;
  project_id: string;
  subject: string;
  attribute: string;
  status: string;
  is_profile: boolean;
  confidence: number | null;
  salience: number | null;
  importance: number | null;
  evidence_count: number | null;
  created_at: string;
  current_value: unknown;
  versions: BeliefVersionItem[];
}

export interface ConversationDetail {
  id: string;
  project_id: string;
  title: string | null;
  started_at: string;
  ended_at: string | null;
  messages: ConversationMessage[];
}

/** 消解历史（#18）：server 直接返回 drizzle 行，键为 camelCase */
export interface ResolutionTrace {
  id: string;
  projectId: string;
  beliefId: string;
  observationId: string;
  previousVersionId: string | null;
  resultVersionId: string | null;
  relation: string | null;
  confidenceBefore: number | null;
  confidenceAfter: number | null;
  policies: unknown;
  modelSnapshot: unknown;
  resolverVersion: string;
  createdAt: string;
}

export interface CorrectResult {
  beliefId: string;
  route: string;
  relation: string | null;
}

export type BeliefListParams = Partial<MemoryListQuery>;

export interface ListParams {
  limit?: number;
  offset?: number;
}

/* ---------- 错误 ---------- */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode | null,
    public readonly detail: string,
    public readonly errors?: FieldError[],
    public readonly requestId?: string,
  ) {
    super(detail);
    this.name = "ApiError";
  }
}

/* ---------- client ---------- */

export interface ApiClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  token?: string;
  timeoutMs?: number;
}

type QueryValue = string | number | undefined;

function toQuery<T extends { [K in keyof T]: QueryValue }>(params: T): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params) as [string, QueryValue][]) {
    if (v !== undefined) q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

export function createApiClient(options: ApiClientOptions) {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function requestResponse(
    path: string,
    init?: RequestInit,
    timeoutMs = options.timeoutMs,
  ): Promise<Response> {
    const headers = new Headers(init?.headers);
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    const signals = [
      init?.signal,
      timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
    ].filter((signal): signal is AbortSignal => signal != null);
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    signal?.throwIfAborted();
    const res = await doFetch(`${base}${path}`, {
      ...init,
      headers,
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      if (body && typeof body === "object" && "status" in body && "code" in body) {
        const p = body as {
          status: number;
          code: ErrorCode;
          detail?: string;
          errors?: FieldError[];
          requestId?: string;
        };
        throw new ApiError(p.status, p.code, p.detail ?? res.statusText, p.errors, p.requestId);
      }
      throw new ApiError(res.status, null, text || res.statusText);
    }
    return res;
  }
  async function request<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
    return (await (await requestResponse(path, init, timeoutMs)).json()) as T;
  }

  const post = <T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> =>
    request<T>(
      path,
      body === undefined
        ? { method: "POST" }
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
      timeoutMs,
    );

  return {
    recordApproval: (projectId: string, event: ApprovalAuditEvent) =>
      post<ApprovalAuditRecord>(`/projects/${projectId}/approvals`, event, 5000),
    listApprovalAudits: (projectId: string, params: Partial<ApprovalAuditQuery> = {}) =>
      request<ApprovalAuditPage>(
        `/projects/${projectId}/approvals${toQuery(params)}`,
        undefined,
        5000,
      ),
    openMessageStream: (
      projectId: string,
      conversationId: string,
      text: string,
      signal?: AbortSignal,
    ) =>
      requestResponse(
        `/projects/${projectId}/conversations/${conversationId}/messages/stream`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
          ...(signal ? { signal } : {}),
        },
        600_000,
      ),
    cancelMessageStream: async (
      projectId: string,
      conversationId: string,
      generationId: string,
    ): Promise<ChatStreamCancel> =>
      (await (
        await requestResponse(
          `/projects/${projectId}/conversations/${conversationId}/generations/${generationId}/cancel`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          },
          10_000,
        )
      ).json()) as ChatStreamCancel,
    createConversation: (projectId: string, title?: string) =>
      post<ChatConversation>("/v1/conversations", {
        project_id: projectId,
        ...(title !== undefined ? { title } : {}),
      }),
    sendMessage: (conversationId: string, text: string) =>
      post<ChatReply>(`/v1/conversations/${conversationId}/messages`, { text }),
    commitConversation: (conversationId: string) =>
      post<ChatCommit>(`/v1/conversations/${conversationId}/commit`),
    resumeConversation: (
      projectId: string,
      conversationId: string,
      currentConversationId?: string,
    ) =>
      post<ChatResume>(
        `/projects/${projectId}/conversations/${conversationId}/resume`,
        currentConversationId === undefined
          ? {}
          : { current_conversation_id: currentConversationId },
      ),
    health: () => request<{ status: string }>("/health"),
    doctor: (probe = false): Promise<DoctorReport> =>
      probe ? post<DoctorReport>("/v1/doctor/probe", {}) : request<DoctorReport>("/v1/doctor"),
    recallBeliefs: (projectId: string, query: string) =>
      post<RecallResult>(`/projects/${projectId}/recall`, { query }),
    getProjectStatus: (projectId: string, conversationId: string) =>
      request<ProjectStatus>(
        `/projects/${projectId}/status${toQuery({ conversation_id: conversationId })}`,
      ),
    getConfig: () => request<ServerConfig>("/v1/config"),
    updateProvider: (id: string, patch: ProviderPatch) =>
      request<ProviderConfig>(`/providers/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }),
    listBeliefs: (projectId: string, params: BeliefListParams = {}) =>
      request<BeliefListItem[]>(`/projects/${projectId}/beliefs${toQuery(params)}`),
    getBelief: (projectId: string, id: string) =>
      request<BeliefDetail>(`/projects/${projectId}/beliefs/${id}`),
    deleteBelief: (projectId: string, id: string) =>
      post<{ id: string; status: string }>(`/projects/${projectId}/beliefs/${id}/delete`),
    restoreBelief: (projectId: string, id: string) =>
      post<{ id: string; status: string }>(`/projects/${projectId}/beliefs/${id}/restore`),
    listConversations: (projectId: string, params: ListParams = {}) =>
      request<ConversationListItem[]>(`/projects/${projectId}/conversations${toQuery(params)}`),
    getConversation: (projectId: string, id: string) =>
      request<ConversationDetail>(`/projects/${projectId}/conversations/${id}`),
    correctBelief: (projectId: string, beliefId: string, value: string) =>
      post<CorrectResult>(`/projects/${projectId}/beliefs/${beliefId}/correct`, { value }),
    listResolutions: (projectId: string, beliefId: string) =>
      request<ResolutionTrace[]>(`/projects/${projectId}/beliefs/${beliefId}/resolutions`),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
