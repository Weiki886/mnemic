import { asc } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { uuidv7 } from "uuidv7";
import { providerConfigs, resolutionTraces } from "../db/schema.js";
import type { ModelSlots } from "../providers/repository.js";
import type { ResolutionTraceRecord, ResolutionTraceWriter } from "./types.js";

/**
 * resolution_traces 落库 writer（#18）。
 * model_snapshot（§11 实验锁定）：落库时从 provider_configs 现查 extraction 槽位
 * （provider + model 名称/版本）；未配置时记 null。温度由提取侧常量锁定（#12 校准）。
 */
export class DbResolutionTraceWriter implements ResolutionTraceWriter {
  constructor(private db: PostgresJsDatabase) {}

  async write(record: ResolutionTraceRecord): Promise<void> {
    await this.db.insert(resolutionTraces).values({
      id: uuidv7(),
      projectId: record.projectId,
      beliefId: record.beliefId,
      observationId: record.observationId,
      previousVersionId: record.previousVersionId,
      resultVersionId: record.resultVersionId,
      relation: record.relation,
      confidenceBefore: record.confidenceBefore === null ? null : String(record.confidenceBefore),
      confidenceAfter: record.confidenceAfter === null ? null : String(record.confidenceAfter),
      policies: record.policies,
      modelSnapshot: await loadModelSnapshot(this.db),
      resolverVersion: record.resolverVersion,
    });
  }
}

/** 提取模型快照：最早创建且配置了 extraction 槽位的 Provider（与 slots.resolveModel 同一选取规则） */
async function loadModelSnapshot(db: PostgresJsDatabase): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select({ name: providerConfigs.name, models: providerConfigs.models })
    .from(providerConfigs)
    .orderBy(asc(providerConfigs.createdAt));
  const row = rows.find((r) => (r.models as ModelSlots).extraction !== undefined);
  if (!row) return null;
  return { slot: "extraction", provider: row.name, model: (row.models as ModelSlots).extraction };
}
