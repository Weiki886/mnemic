import { z } from "zod";
import { buildMemoryBenchmark } from "./memory-benchmark.js";

const prompt = "Answer from the provided project history. If the evidence is insufficient, say so.";

type Message = Readonly<{ role: "system" | "user"; content: string }>;

type ContextModel = {
  countInputTokens(messages: readonly Message[]): number | Promise<number>;
  answer(messages: readonly Message[]): string | Promise<string>;
};

const runOptions = z
  .object({
    inputTokenBudget: z.number().int().positive().safe(),
    windowSessionCount: z.number().int().positive().safe(),
    questionIds: z
      .array(z.string())
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
  })
  .strict();

type Baseline = "no-memory" | "sliding-window" | "full-context";

type ResultRow = {
  questionId: string;
  baseline: Baseline;
  sessionIds: string[];
  inputTokens: number;
} & ({ status: "answered"; answer: string } | { status: "context-overflow" });

export async function runContextBaselines(input: unknown, model: ContextModel) {
  const options = runOptions.parse(input);
  const benchmark = buildMemoryBenchmark();
  const cases = benchmark.projects.flatMap((project) =>
    project.questions.map((question) => ({ project, question })),
  );
  const ids = new Set(options.questionIds);
  const selected = options.questionIds
    ? cases.filter(({ question }) => ids.has(question.id))
    : cases;
  if (options.questionIds && selected.length !== ids.size)
    throw Error("UNKNOWN_BENCHMARK_QUESTION");

  const rows: ResultRow[] = [];
  for (const { project, question } of selected) {
    const cutoff = project.sessions.findIndex((session) => session.id === question.untilSessionId);
    if (cutoff < 0) throw Error("UNKNOWN_BENCHMARK_CUTOFF");
    const visible = project.sessions.slice(0, cutoff + 1);
    const contexts: ReadonlyArray<readonly [Baseline, typeof visible]> = [
      ["no-memory", []],
      ["sliding-window", visible.slice(-options.windowSessionCount)],
      ["full-context", visible],
    ];

    for (const [baseline, sessions] of contexts) {
      const inputMessages: Message[] = [
        { role: "system", content: prompt },
        ...sessions.flatMap((session) =>
          session.messages.map(({ speaker, text }) => ({ role: speaker, content: text })),
        ),
        { role: "user", content: question.text },
      ];
      const messages = Object.freeze(inputMessages.map((message) => Object.freeze(message)));
      const inputTokens = await model.countInputTokens(messages);
      if (!Number.isSafeInteger(inputTokens) || inputTokens <= 0) {
        throw Error("INVALID_CONTEXT_TOKEN_COUNT");
      }

      const row = {
        questionId: question.id,
        baseline,
        sessionIds: sessions.map((session) => session.id),
        inputTokens,
      };
      if (inputTokens > options.inputTokenBudget) {
        rows.push({ ...row, status: "context-overflow" });
      } else {
        const answer = await model.answer(messages);
        rows.push({ ...row, status: "answered", answer });
      }
    }
  }

  return {
    schemaVersion: 1,
    datasetId: benchmark.datasetId,
    inputTokenBudget: options.inputTokenBudget,
    windowSessionCount: options.windowSessionCount,
    rows,
  };
}
