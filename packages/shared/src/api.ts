/** 类型化 API client（#8）：Web 记忆中心经 packages/shared 调 server API。
 *  - 键名与 server 响应保持一致：读路由为 snake_case，resolutions 为 drizzle 直出的 camelCase。
 *  - 错误统一转 ApiError：problem+json → 结构化字段；非 problem 体 → status + 原始文本。
 *  - fetch 可注入（默认全局 fetch），便于单测与非浏览器环境。 */

import type { ErrorCode, FieldError } from "./errors.js";

/* ---------- 响应类型（与 apps/server 路由返回结构对齐） ---------- */

export interface BeliefListItem {
  id: string;
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
}

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

export interface ConversationListItem {
  id: string;
  title: string | null;
  started_at: string;
  ended_at: string | null;
  message_count: number;
}

export interface CitedMemory {
  belief_version_id: string;
  belief_id: string;
  subject: string;
  attribute: string;
  value: unknown;
}

export interface ConversationMessage {
  id: string;
  speaker: string;
  raw_text: string;
  msg_time: string;
  memories: CitedMemory[] | null;
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

export interface BeliefListParams {
  status?: "active" | "deleted" | "retracted" | "all";
  profile?: "true" | "false";
  q?: string;
  limit?: number;
  offset?: number;
}

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

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await doFetch(`${base}${path}`, init);
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
    return (await res.json()) as T;
  }

  const post = <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(
      path,
      body === undefined
        ? { method: "POST" }
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    );

  return {
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
    correctBelief: (beliefId: string, value: string) =>
      post<CorrectResult>(`/beliefs/${beliefId}/correct`, { value }),
    listResolutions: (beliefId: string) =>
      request<ResolutionTrace[]>(`/beliefs/${beliefId}/resolutions`),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
