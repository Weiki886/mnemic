/**
 * Drizzle schema（#3 数据模型 V1）
 *
 * 全局约定（Issue #42 §11）：UUIDv7 主键（应用层 uuidv7 包生成，DB 层不设默认，
 * 以强制应用层纪律）；timestamptz；评分类 numeric(4,3)；project_id 贯穿业务表；
 * 枚举以 pg enum 实现。
 *
 * 两条 #3 落地时固定的设计决策（迁移注释同步）：
 * 1. RETRACT 后 Belief 的 status 落点 = 'retracted'（deleted=硬删除、expired=自然失效，语义均不符）。
 * 2. Observation.valid_time（证据声称的生效时点，单点）落为 BeliefVersion 区间：
 *    valid_from = valid_time，valid_to = null（开口）；被取代时由 Resolver 关闭 valid_to/recorded_to。
 *    边界：valid_time 可空（证据未声称生效时点），而 belief_versions.valid_from 非空——
 *    此时 valid_from 兜底为 Observation.recorded_at（系统首次获知之时），由 #16/#17 转换实现遵守。
 *
 * authority 映射（决策 4，创建即写入，非 Resolver 前现算）：
 * USER_CORRECTION=70 > USER_EXPLICIT=60 > PROJECT_FILE=50 > TOOL_OBSERVATION=40
 * > DOCUMENT=30 > WEB_CONTENT=20 > AGENT_INFERENCE=10（步进 10，预留插入位）。
 */
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey();
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const score = (name: string) => numeric(name, { precision: 4, scale: 3 });

export const speakerEnum = pgEnum("speaker", ["user", "assistant", "tool"]);
export const observationTypeEnum = pgEnum("observation_type", [
  "fact",
  "preference",
  "decision",
  "progress",
]);
export const assertionIntentEnum = pgEnum("assertion_intent", [
  "ASSERT",
  "UPDATE",
  "CORRECT",
  "RETRACT",
]);
export const sourceTypeEnum = pgEnum("source_type", [
  "USER_CORRECTION",
  "USER_EXPLICIT",
  "PROJECT_FILE",
  "TOOL_OBSERVATION",
  "DOCUMENT",
  "WEB_CONTENT",
  "AGENT_INFERENCE",
]);
export const timePrecisionEnum = pgEnum("time_precision", ["DAY", "WEEK", "MONTH", "FUZZY"]);
export const beliefStatusEnum = pgEnum("belief_status", [
  "active",
  "superseded",
  "expired",
  "deleted",
  "retracted",
]);

/** 项目命名空间（能力 2.5） */
export const projects = pgTable("projects", {
  id: id(),
  name: text("name").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  meta: jsonb("meta"),
});

/** Evidence 层：原始会话，全量持久化（决策 1） */
export const conversations = pgTable("conversations", {
  id: id(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  title: text("title"),
  startedAt: ts("started_at").notNull().defaultNow(),
  endedAt: ts("ended_at"),
  meta: jsonb("meta"),
});

/** Evidence 层：消息是 Provenance 锚点（Observation.evidence_id → messages.id） */
export const messages = pgTable("messages", {
  id: id(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id),
  speaker: speakerEnum("speaker").notNull(),
  rawText: text("raw_text").notNull(),
  msgTime: ts("msg_time").notNull(),
});

/**
 * Observation：结构化不可变事实事件。
 * 不可变约束 = 应用层无 update 路径 + 无 updated_at 列 + 集成测试断言。
 */
export const observations = pgTable("observations", {
  id: id(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  type: observationTypeEnum("type").notNull(),
  subject: text("subject").notNull(),
  attribute: text("attribute").notNull(),
  value: jsonb("value").notNull(),
  assertionIntent: assertionIntentEnum("assertion_intent").notNull(),
  sourceType: sourceTypeEnum("source_type").notNull(),
  /** 由 source_type 映射的排序值（决策 4：创建即写入） */
  authority: smallint("authority").notNull(),
  reliability: score("reliability"),
  /** 证据声称的生效时点（单点）；落 BeliefVersion 时展开为区间 */
  validTime: ts("valid_time"),
  timePrecision: timePrecisionEnum("time_precision").notNull().default("DAY"),
  timeConfidence: score("time_confidence").notNull().default("1.000"),
  recordedAt: ts("recorded_at").notNull().defaultNow(),
  evidenceId: uuid("evidence_id")
    .notNull()
    .references(() => messages.id),
  importance: score("importance"),
  /** 提取评估值（≠ Belief 级 confidence） */
  confidence: score("confidence"),
  /** 实体数组，A1 #9 实体路数据来源 */
  entities: jsonb("entities"),
  /** #4 在提取候选上输出，#16 创建 Belief 时复制入行 */
  isProfile: boolean("is_profile").notNull().default(false),
});

/** Belief：当前信念（project_id+subject+attribute 唯一逻辑实体） */
export const beliefs = pgTable(
  "beliefs",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    subject: text("subject").notNull(),
    attribute: text("attribute").notNull(),
    currentVersionId: uuid("current_version_id").references(
      (): AnyPgColumn => beliefVersions.id,
    ),
    evidenceCount: integer("evidence_count").notNull().default(1),
    // 三字段分离（决策 6）：confidence 多可信 / salience 多值得召回 / importance 多重要
    confidence: score("confidence"),
    salience: score("salience"),
    importance: score("importance"),
    isProfile: boolean("is_profile").notNull().default(false),
    profileDirty: boolean("profile_dirty").notNull().default(false),
    status: beliefStatusEnum("status").notNull().default("active"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("beliefs_project_subject_attribute_key").on(
    table.projectId,
    table.subject,
    table.attribute,
  )],
);

/**
 * BeliefVersion：完整双时态（决策 2），只追加。
 * 内容列（value/valid_from/supersedes_version_id/...）不物理修改；
 * 唯一允许的 UPDATE 是区间关闭（recorded_to/valid_to）——集成测试断言。
 */
export const beliefVersions = pgTable("belief_versions", {
  id: id(),
  beliefId: uuid("belief_id")
    .notNull()
    .references(() => beliefs.id),
  value: jsonb("value").notNull(),
  /** 现实何时为真；null = 开口 */
  validFrom: ts("valid_from").notNull(),
  validTo: ts("valid_to"),
  /** 系统何时认为为真；null = 开口 */
  recordedFrom: ts("recorded_from").notNull(),
  recordedTo: ts("recorded_to"),
  supersedesVersionId: uuid("supersedes_version_id").references(
    (): AnyPgColumn => beliefVersions.id,
  ),
  sourceObservationId: uuid("source_observation_id").references(() => observations.id),
  /** 产生本版本的 Resolver 版本 */
  resolverVersion: text("resolver_version"),
  confidence: score("confidence"),
});

/**
 * 向量索引（运行时 owner：retrieval 模块）。
 * 维度 1024 = Qwen3-Embedding-0.6B 默认；换维度走 REEMBED 迁移（#1 §11）。
 * HNSW 索引在迁移 SQL 中创建（drizzle-kit 不管理）。
 */
export const memoryEmbeddings = pgTable("memory_embeddings", {
  id: id(),
  beliefVersionId: uuid("belief_version_id")
    .notNull()
    .references(() => beliefVersions.id),
  embedding: vector("embedding", { dimensions: 1024 }).notNull(),
  model: text("model").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** 平台审计表（#3 迁移；#15 脱敏 / #34 审批 / #23/#25/#26 复用；meta 按写入方定 schema） */
export const auditLog = pgTable("audit_log", {
  id: id(),
  ts: ts("ts").notNull().defaultNow(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  target: text("target"),
  decision: text("decision"),
  meta: jsonb("meta"),
});
