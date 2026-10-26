import { asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { EmbeddingModel, LanguageModel } from "ai";
import { providerConfigs } from "../db/schema.js";
import { decrypt } from "./crypto.js";
import { realProviderFactory, type ProviderFactory } from "./factory.js";
import type { ModelSlots, ProviderWithKey } from "./repository.js";
import { selectSlotProvider } from "./selection.js";
import { observeEmbedding, observeLanguage, type UsageLogger } from "../usage/models.js";
import { writeModelUsage, type UsageContext, type UsageRecord } from "../usage/repository.js";
import type { ModelDebug, ModelDebugFactory } from "../debug/model-content.js";
import type { DebugTrace } from "../debug/trace.js";

/** 模型三槽位（ADR-005）：调用方只按用途取模型，不感知厂商与协议 */
export type Slot = keyof Required<ModelSlots>;

export interface ResolveOptions {
  debugTrace?: DebugTrace;
  modelDebug?: ModelDebug;
  /** Server-resolved physical Evidence; never taken from HTTP model options. */
  debugEvidenceId?: string;
  /** 指定 Provider；缺省时取最早创建且配置了该槽位的 Provider */
  providerName?: string;
  /** 测试注入 Fake；生产默认真实双协议工厂 */
  factory?: ProviderFactory;
  /** Trusted server context only. Never spread HTTP bodies into model options. */
  usageContext?: UsageContext;
  usageLogger?: UsageLogger;
}

export interface ResolvedModel<M = LanguageModel | EmbeddingModel> {
  model: M;
  modelId: string;
  providerName: string;
  slot: Slot;
}

export async function resolveModel(
  db: PostgresJsDatabase,
  masterKey: Buffer,
  slot: "embedding",
  options?: ResolveOptions,
): Promise<ResolvedModel<EmbeddingModel>>;
export async function resolveModel(
  db: PostgresJsDatabase,
  masterKey: Buffer,
  slot: "chat" | "extraction",
  options?: ResolveOptions,
): Promise<ResolvedModel<LanguageModel>>;
export async function resolveModel(
  db: PostgresJsDatabase,
  masterKey: Buffer,
  slot: Slot,
  options: ResolveOptions = {},
): Promise<ResolvedModel> {
  const factory = options.factory ?? realProviderFactory;
  const rows = options.providerName
    ? await db.select().from(providerConfigs).where(eq(providerConfigs.name, options.providerName))
    : await db
        .select()
        .from(providerConfigs)
        .orderBy(asc(providerConfigs.createdAt), asc(providerConfigs.id));

  const row = selectSlotProvider(rows, slot);
  if (!row) {
    const scope = options.providerName ? `Provider「${options.providerName}」` : "任何 Provider";
    throw new Error(`${scope}未配置 ${slot} 槽位模型`);
  }

  const config: ProviderWithKey = {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    baseUrl: row.baseUrl,
    apiKey: decrypt(row.apiKeyEncrypted, masterKey),
    models: row.models as ModelSlots,
    createdAt: row.createdAt,
  };
  const modelId = config.models[slot]!;
  const rawModel =
    slot === "embedding"
      ? factory.embeddingModel(config, modelId)
      : factory.languageModel(config, modelId);
  if (typeof rawModel === "string") throw new Error("ProviderFactory must return a model instance");
  const context = options.usageContext ?? {
    projectId: null,
    conversationId: null,
    purpose: slot === "embedding" ? "embedding_query" : slot,
  };
  const base = { ...context, providerName: row.name, modelId, slot };
  const sink = (record: UsageRecord) => writeModelUsage(db, record);
  let debug: ModelDebugFactory | undefined;
  if (
    slot !== "embedding" &&
    context.purpose === slot &&
    context.projectId &&
    context.conversationId &&
    options.debugEvidenceId
  ) {
    try {
      debug = options.modelDebug?.(
        {
          project_id: context.projectId,
          conversation_id: context.conversationId,
          evidence_id: options.debugEvidenceId,
          provider_name: row.name,
          model_id: modelId,
          slot,
        },
        config.apiKey,
      );
    } catch {
      /* Debug setup cannot prevent a paid business request. */
    }
  }
  const model =
    slot === "embedding"
      ? observeEmbedding(
          rawModel as Exclude<EmbeddingModel, string>,
          base,
          sink,
          options.usageLogger,
        )
      : observeLanguage(
          rawModel as Exclude<LanguageModel, string>,
          base,
          sink,
          options.usageLogger,
          debug,
        );
  return { model, modelId, providerName: row.name, slot };
}
