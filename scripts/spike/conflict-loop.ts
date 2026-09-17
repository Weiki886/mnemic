/**
 * Spike ③：写入→检索→冲突改判 最小闭环（允许最丑实现）
 * 运行：pnpm --filter @mnemic/spike run spike:conflict
 * 目的：验证双时态版本化 + 冲突取代 + as-of 查询 的 SQL 模式可行
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? "postgres://mnemic:mnemic@localhost:5432/mnemic";
const sql = postgres(url);

/** 最丑假提取器：识别 "数据库用 X" / "改用 X" */
function fakeExtract(text: string) {
  const m = text.match(/(?:数据库用|改用)\s*(\w+)/);
  if (!m) return null;
  return {
    subject: "demo-project",
    attribute: "数据库",
    value: m[1]!,
    intent: text.includes("改用") ? "UPDATE" : "ASSERT",
    validTime: new Date(),
  };
}

async function currentBelief(subject: string, attribute: string) {
  const rows = await sql<{ value: string }[]>`
    SELECT bv.value FROM spike_belief_versions bv
    JOIN spike_beliefs b ON b.id = bv.belief_id
    WHERE b.subject = ${subject} AND b.attribute = ${attribute}
      AND bv.recorded_to IS NULL
    ORDER BY bv.recorded_from DESC LIMIT 1
  `;
  return rows[0]?.value ?? null;
}

async function main() {
  await sql`DROP TABLE IF EXISTS spike_belief_versions`;
  await sql`DROP TABLE IF EXISTS spike_beliefs`;
  await sql`
    CREATE TABLE spike_beliefs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      subject text NOT NULL, attribute text NOT NULL
    )
  `;
  await sql`
    CREATE TABLE spike_belief_versions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      belief_id uuid REFERENCES spike_beliefs(id),
      value text NOT NULL,
      valid_from timestamptz NOT NULL, valid_to timestamptz,
      recorded_from timestamptz NOT NULL DEFAULT now(), recorded_to timestamptz
    )
  `;

  const results: Record<string, unknown> = {};

  // ① 首次写入：ASSERT PostgreSQL
  const first = fakeExtract("我们数据库用 PostgreSQL")!;
  const [belief] = await sql<{ id: string }[]>`
    INSERT INTO spike_beliefs ${sql({ subject: first.subject, attribute: first.attribute })}
    RETURNING id
  `;
  await sql`
    INSERT INTO spike_belief_versions ${sql({
      belief_id: belief!.id,
      value: first.value,
      valid_from: first.validTime,
    })}
  `;
  results["首次写入后检索"] = await currentBelief(first.subject, first.attribute);

  // ② 冲突写入：UPDATE → SQLite（模拟数日后）
  await new Promise((r) => setTimeout(r, 50)); // 保证 recorded_from 不同
  const second = fakeExtract("改用 SQLite 吧")!;
  // 冲突检测：同 subject+attribute 存在当前版本
  const existing = await currentBelief(second.subject, second.attribute);
  results["冲突检测命中旧值"] = existing;
  if (existing && existing !== second.value && second.intent === "UPDATE") {
    // 取代：旧版本关闭（失效留痕），新版本成为当前
    await sql`
      UPDATE spike_belief_versions SET recorded_to = now(), valid_to = ${second.validTime}
      WHERE belief_id = ${belief!.id} AND recorded_to IS NULL
    `;
    await sql`
      INSERT INTO spike_belief_versions ${sql({
        belief_id: belief!.id,
        value: second.value,
        valid_from: second.validTime,
      })}
    `;
  }
  results["改判后检索"] = await currentBelief(second.subject, second.attribute);

  // ③ as-of 查询：T1 之后、改判之前的系统认知
  const asOf = await sql<{ value: string }[]>`
    SELECT value FROM spike_belief_versions
    WHERE belief_id = ${belief!.id}
      AND recorded_from <= now() - interval '25 milliseconds'
      AND (recorded_to IS NULL OR recorded_to > now() - interval '25 milliseconds')
    ORDER BY recorded_from DESC LIMIT 1
  `;
  results["as-of改判前"] = asOf[0]?.value ?? null;

  const versions = await sql<{ value: string; recorded_to: string | null }[]>`
    SELECT value, recorded_to FROM spike_belief_versions WHERE belief_id = ${belief!.id} ORDER BY recorded_from
  `;
  results["版本链"] = versions;

  await sql`DROP TABLE spike_belief_versions`;
  await sql`DROP TABLE spike_beliefs`;

  console.log(JSON.stringify(results, null, 2));
  const pass =
    results["首次写入后检索"] === "PostgreSQL" &&
    results["冲突检测命中旧值"] === "PostgreSQL" &&
    results["改判后检索"] === "SQLite" &&
    results["as-of改判前"] === "PostgreSQL" &&
    versions.length === 2 &&
    versions[0]!.recorded_to !== null;
  console.log(pass ? "SPIKE-③ PASS" : "SPIKE-③ FAIL");
  await sql.end();
  process.exit(pass ? 0 : 1);
}

await main();
