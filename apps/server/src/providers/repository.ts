import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { uuidv7 } from "uuidv7";
import { providerConfigs } from "../db/schema.js";
import { decrypt, encrypt, maskApiKey } from "./crypto.js";

/** 三槽位模型配置（ADR-005）；槽位未配置时该键缺省 */
export interface ModelSlots {
  chat?: string;
  extraction?: string;
  embedding?: string;
}

export interface CreateProviderInput {
  name: string;
  protocol: "openai-compatible" | "anthropic";
  baseUrl: string;
  apiKey: string;
  models: ModelSlots;
}

/** 对外视图：永不含明文与密文 */
export interface ProviderView {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  apiKeyMasked: string;
  models: ModelSlots;
  createdAt: Date;
}

/** 服务端内部视图：含明文 Key，仅限服务端链路（槽位解析）使用 */
export interface ProviderWithKey extends Omit<ProviderView, "apiKeyMasked"> {
  apiKey: string;
}

type Db = PostgresJsDatabase;

function toView(row: typeof providerConfigs.$inferSelect, masterKey: Buffer): ProviderView {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    baseUrl: row.baseUrl,
    apiKeyMasked: maskApiKey(decrypt(row.apiKeyEncrypted, masterKey)),
    models: row.models as ModelSlots,
    createdAt: row.createdAt,
  };
}

export async function createProvider(
  db: Db,
  masterKey: Buffer,
  input: CreateProviderInput,
): Promise<ProviderView> {
  const rows = await db
    .insert(providerConfigs)
    .values({
      id: uuidv7(),
      name: input.name,
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      apiKeyEncrypted: encrypt(input.apiKey, masterKey),
      models: input.models,
    })
    .returning();
  return toView(rows[0]!, masterKey);
}

export async function listProviders(db: Db, masterKey: Buffer): Promise<ProviderView[]> {
  const rows = await db.select().from(providerConfigs).orderBy(providerConfigs.createdAt);
  return rows.map((r) => toView(r, masterKey));
}

/** 仅服务端链路（槽位解析）调用；返回值禁止出现在任何 HTTP 响应与日志中 */
export async function getProviderWithKey(
  db: Db,
  masterKey: Buffer,
  name: string,
): Promise<ProviderWithKey> {
  const rows = await db.select().from(providerConfigs).where(eq(providerConfigs.name, name));
  const row = rows[0];
  if (!row) {
    throw new Error(`Provider 不存在：${name}`);
  }
  const { apiKeyMasked: _drop, ...rest } = toView(row, masterKey);
  return { ...rest, apiKey: decrypt(row.apiKeyEncrypted, masterKey) };
}
