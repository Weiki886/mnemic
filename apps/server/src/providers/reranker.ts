import { asc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import {
  ProviderRerankerCreateSchema,
  ProviderRerankerStateSchema,
  ProviderRerankerUpdateSchema,
  QWEN_RERANKER_MODEL,
  type ProviderRerankerConfigSchema,
} from "@mnemic/shared/management";
import { providerConfigs } from "../db/schema.js";
import { writePlatformAudit } from "../audit/events.js";
import { decrypt, encrypt } from "./crypto.js";
import { parseRerankConfig } from "../retrieval/reranker-input.js";
const Id = z.string().uuid().toLowerCase();
type Db = PostgresJsDatabase;
type Config = z.infer<typeof ProviderRerankerConfigSchema>;
export class ProviderRerankerError extends Error {
  constructor(readonly reason: "not_found" | "conflict" | "exhausted" | "endpoint") {
    super(`RERANKER_PROVIDER_${reason.toUpperCase()}`);
  }
}
function state(value: unknown) {
  const parsed = ProviderRerankerStateSchema.safeParse(value);
  if (!parsed.success) throw Error("RERANKER_CONFIG_UNAVAILABLE");
  return parsed.data;
}
function view(id: string, value: unknown) {
  return { provider_id: id, model_id: QWEN_RERANKER_MODEL, ...state(value) };
}
/** An explicit root-relative path keeps Provider origin and credential ownership together. */
function endpoint(base: string, config: Config) {
  try {
    if (base.trim() !== base || /[\p{Cc}\p{Cs}]/u.test(base)) throw Error();
    const url = new URL(base);
    url.pathname = config.endpoint_path;
    return parseRerankConfig({ endpoint: url.href, timeoutMs: config.timeout_ms });
  } catch {
    throw new ProviderRerankerError("endpoint");
  }
}
export async function readProviderRerankerConfig(db: Db, id: string) {
  const identity = Id.parse(id);
  const [row] = await db
    .select({ id: providerConfigs.id, config: providerConfigs.rerankerConfig })
    .from(providerConfigs)
    .where(eq(providerConfigs.id, identity))
    .limit(1);
  if (!row) throw new ProviderRerankerError("not_found");
  return view(row.id, row.config);
}
export async function createRerankerProvider(db: Db, masterKey: Buffer, value: unknown) {
  const input = ProviderRerankerCreateSchema.parse(value);
  endpoint(input.base_url, input.config);
  return db.transaction(async (tx) => {
    const id = uuidv7(),
      config = { revision: 0, config: input.config };
    await tx.insert(providerConfigs).values({
      id,
      name: input.name,
      protocol: "openai-compatible",
      baseUrl: input.base_url,
      apiKeyEncrypted: encrypt(input.api_key, masterKey),
      models: {},
      rerankerConfig: config,
    });
    await writePlatformAudit(tx, {
      actor: "server",
      action: "provider.reranker.create",
      target: id,
      decision: "created",
      meta: { version: 1, revision: 0, configured: true },
    });
    return view(id, config);
  });
}
export async function updateProviderRerankerConfig(db: Db, id: string, value: unknown) {
  const identity = Id.parse(id),
    input = ProviderRerankerUpdateSchema.parse(value);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: providerConfigs.id,
        baseUrl: providerConfigs.baseUrl,
        config: providerConfigs.rerankerConfig,
      })
      .from(providerConfigs)
      .where(eq(providerConfigs.id, identity))
      .for("update");
    if (!row) throw new ProviderRerankerError("not_found");
    const old = state(row.config);
    if (old.revision !== input.expected_revision) throw new ProviderRerankerError("conflict");
    if (JSON.stringify(old.config) === JSON.stringify(input.config))
      return { kind: "unchanged" as const, ...view(row.id, old) };
    if (old.revision === Number.MAX_SAFE_INTEGER) throw new ProviderRerankerError("exhausted");
    if (input.config) endpoint(row.baseUrl, input.config);
    const next = { revision: old.revision + 1, config: input.config };
    await tx
      .update(providerConfigs)
      .set({ rerankerConfig: next, updatedAt: new Date() })
      .where(eq(providerConfigs.id, identity));
    await writePlatformAudit(tx, {
      actor: "server",
      action: "provider.reranker.update",
      target: row.id,
      decision: "updated",
      meta: {
        version: 1,
        previous_revision: old.revision,
        revision: next.revision,
        before_configured: old.config !== null,
        after_configured: next.config !== null,
      },
    });
    return { kind: "updated" as const, ...view(row.id, next) };
  });
}
/** Server-only return value contains the decrypted key. Never return it from HTTP or log it. */
export async function resolveProviderRerankerConfig(db: Db, masterKey: Buffer, id: string) {
  const identity = Id.parse(id);
  try {
    const [row] = await db
      .select({
        id: providerConfigs.id,
        baseUrl: providerConfigs.baseUrl,
        key: providerConfigs.apiKeyEncrypted,
        config: providerConfigs.rerankerConfig,
      })
      .from(providerConfigs)
      .where(eq(providerConfigs.id, identity))
      .limit(1);
    if (!row) throw new ProviderRerankerError("not_found");
    return resolveRow(row, masterKey);
  } catch (error) {
    if (error instanceof ProviderRerankerError && error.reason === "not_found") throw error;
    throw Error("RERANKER_CONFIG_UNAVAILABLE");
  }
}

function resolveRow(
  row: { id: string; baseUrl: string; key: string; config: unknown },
  masterKey: Buffer,
) {
  const current = state(row.config);
  if (!current.config) return null;
  const config = parseRerankConfig({
    ...endpoint(row.baseUrl, current.config),
    apiKey: decrypt(row.key, masterKey),
  });
  return { providerId: row.id, modelId: QWEN_RERANKER_MODEL, revision: current.revision, config };
}
/** One SQL snapshot, one chosen credential; never skip a corrupt winner or try a later Provider. */
export async function resolveConfiguredRerankerConfig(db: Db, masterKey: Buffer) {
  try {
    const [row] = await db
      .select({
        id: providerConfigs.id,
        baseUrl: providerConfigs.baseUrl,
        key: providerConfigs.apiKeyEncrypted,
        config: providerConfigs.rerankerConfig,
      })
      .from(providerConfigs)
      .where(sql`${providerConfigs.rerankerConfig}->'config' is distinct from 'null'::jsonb`)
      .orderBy(asc(providerConfigs.createdAt), asc(providerConfigs.id))
      .limit(1);
    return row ? resolveRow(row, masterKey) : null;
  } catch {
    throw Error("RERANKER_CONFIG_UNAVAILABLE");
  }
}
