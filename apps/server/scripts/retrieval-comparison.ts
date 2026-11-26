import { z } from "zod";

function distinct(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const versionIds = z.array(uuid).max(200).refine(distinct);
const ranking = z.object({ traceId: uuid, rankedVersionIds: versionIds }).strict();

const comparison = z
  .object({
    k: z.number().int().min(1).max(200),
    cases: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
            relevantVersionIds: versionIds,
            baseline: ranking,
            variant: ranking,
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict()
  .refine(({ cases }) => distinct(cases.map((entry) => entry.id)))
  .refine(({ cases }) =>
    distinct(cases.flatMap(({ baseline, variant }) => [baseline.traceId, variant.traceId])),
  );

function scoreRanking(run: z.infer<typeof ranking>, relevant: Set<string>, k: number) {
  const prefix = run.rankedVersionIds.slice(0, k);
  const first = prefix.findIndex((id) => relevant.has(id));
  const hits = prefix.filter((id) => relevant.has(id)).length;
  const answerable = relevant.size > 0;
  const abstained = run.rankedVersionIds.length === 0;
  return {
    traceId: run.traceId,
    hitAtK: answerable ? Number(first >= 0) : null,
    recallAtK: answerable ? hits / relevant.size : null,
    mrrAtK: answerable ? (first < 0 ? 0 : 1 / (first + 1)) : null,
    abstained,
    correctAbstention: abstained === !answerable,
  };
}

function mean(values: readonly (number | null)[]): number | null {
  const scored = values.filter((value): value is number => value !== null);
  return scored.length === 0 ? null : scored.reduce((sum, value) => sum + value, 0) / scored.length;
}

function summarize(runs: readonly ReturnType<typeof scoreRanking>[]) {
  return {
    hitAtK: mean(runs.map((run) => run.hitAtK)),
    recallAtK: mean(runs.map((run) => run.recallAtK)),
    mrrAtK: mean(runs.map((run) => run.mrrAtK)),
    abstentionAccuracy: runs.filter((run) => run.correctAbstention).length / runs.length,
  };
}

function difference(baseline: number | null, variant: number | null): number | null {
  return baseline === null || variant === null ? null : variant - baseline;
}

export function scoreRetrievalComparison(input: unknown) {
  const { k, cases } = comparison.parse(input);
  const scored = cases.map((entry) => {
    const relevant = new Set(entry.relevantVersionIds);
    return {
      id: entry.id,
      baseline: scoreRanking(entry.baseline, relevant, k),
      variant: scoreRanking(entry.variant, relevant, k),
    };
  });
  const answerable = cases.filter((entry) => entry.relevantVersionIds.length > 0).length;
  const baseline = summarize(scored.map((entry) => entry.baseline));
  const variant = summarize(scored.map((entry) => entry.variant));
  return {
    k,
    counts: { cases: cases.length, answerable, unanswerable: cases.length - answerable },
    baseline,
    variant,
    delta: {
      hitAtK: difference(baseline.hitAtK, variant.hitAtK),
      recallAtK: difference(baseline.recallAtK, variant.recallAtK),
      mrrAtK: difference(baseline.mrrAtK, variant.mrrAtK),
      abstentionAccuracy: variant.abstentionAccuracy - baseline.abstentionAccuracy,
    },
    cases: scored,
  };
}
