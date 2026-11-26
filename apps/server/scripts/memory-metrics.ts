import { z } from "zod";

const labelId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);

function distinct(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const factIds = z.array(labelId).max(200).refine(distinct);
const write = z.object({ id: labelId, label: z.enum(["relevant", "neutral", "noise"]) }).strict();
const question = z
  .object({
    id: labelId,
    kind: z.enum(["general", "conflict", "temporal"]),
    expected: z.enum(["answer", "abstain"]),
    observed: z.enum(["correct", "incorrect", "abstain"]),
    staleFactIds: factIds,
    recalledFactIds: factIds,
  })
  .strict()
  .refine(({ expected, observed }) => expected !== "abstain" || observed !== "correct");

const run = z
  .object({
    schemaVersion: z.literal(1),
    writes: z.array(write).max(10_000),
    questions: z.array(question).max(1000),
  })
  .strict()
  .refine(({ writes, questions }) => writes.length + questions.length > 0)
  .refine(({ writes }) => distinct(writes.map((entry) => entry.id)))
  .refine(({ questions }) => distinct(questions.map((entry) => entry.id)));

function rate(numerator: number, denominator: number) {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

function answerAccuracy(questions: readonly z.infer<typeof question>[]) {
  return rate(questions.filter((entry) => entry.observed === "correct").length, questions.length);
}

export function scoreMemoryMetrics(input: unknown) {
  const { schemaVersion, writes, questions } = run.parse(input);
  const answerable = questions.filter((entry) => entry.expected === "answer");
  let recalled = 0;
  let stale = 0;
  for (const entry of questions) {
    const staleFacts = new Set(entry.staleFactIds);
    recalled += entry.recalledFactIds.length;
    stale += entry.recalledFactIds.filter((id) => staleFacts.has(id)).length;
  }
  const correctAbstention = questions.filter(
    (entry) => (entry.expected === "abstain") === (entry.observed === "abstain"),
  ).length;

  return {
    schemaVersion,
    writePrecision: rate(
      writes.filter((entry) => entry.label === "relevant").length,
      writes.length,
    ),
    noiseRate: rate(writes.filter((entry) => entry.label === "noise").length, writes.length),
    conflictResolutionAccuracy: answerAccuracy(
      answerable.filter((entry) => entry.kind === "conflict"),
    ),
    temporalAccuracy: answerAccuracy(answerable.filter((entry) => entry.kind === "temporal")),
    staleRecallRate: rate(stale, recalled),
    abstentionAccuracy: rate(correctAbstention, questions.length),
  };
}
