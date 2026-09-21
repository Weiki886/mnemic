import { asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { EmbeddingModel, LanguageModel } from "ai";
import { providerConfigs } from "../db/schema.js";
import { decrypt } from "./crypto.js";
import { realProviderFactory, type ProviderFactory } from "./factory.js";
import type { ModelSlots, ProviderWithKey } from "./repository.js";

/** 模型三槽位（ADR-005）：调用方只按用途取模型，不感知厂商与协议 */
export type Slot = keyof Required<ModelSlots>;

export interface ResolveOptions {
  /** 指定 Provider；缺省时取最早创建且配置了该槽位的 Provider */
  providerName?: string;
  /** 测试注入 Fake；生产默认真实双协议工厂 */
  factory?: ProviderFactory;
}

export interface ResolvedModel {
  model: LanguageModel | EmbeddingModel;
  modelId: string;
  providerName: string;
  slot: Slot;
}

export async function resolveModel(
  db: PostgresJsDatabase,
  masterKey: Buffer,
  slot: Slot,
  options: ResolveOptions = {},
): Promise<ResolvedModel> {
  const factory = options.factory ?? realProviderFactory;
  const rows = options.providerName
    ? await db.select().from(providerConfigs).where(eq(providerConfigs.name, options.providerName))
    : await db.select().from(providerConfigs).orderBy(asc(providerConfigs.createdAt));

  const row = rows.find((r) => (r.models as ModelSlots)[slot] !== undefined);
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
  const model =
    slot === "embedding"
      ? factory.embeddingModel(config, modelId)
      : factory.languageModel(config, modelId);
  return { model, modelId, providerName: row.name, slot };
}
