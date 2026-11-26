import { expect, it, vi } from "vitest";
import { runContextBaselines } from "../scripts/context-baselines.js";
import { buildMemoryBenchmark } from "../scripts/memory-benchmark.js";

const options = {
  inputTokenBudget: 20,
  windowSessionCount: 2,
  questionIds: ["database-before-correction", "database-after-correction"],
};
const benchmark = buildMemoryBenchmark();
const database = benchmark.projects[0]!;

function offlineModel() {
  return {
    countInputTokens: vi.fn((messages: readonly unknown[]) => messages.length),
    answer: vi.fn((_messages: readonly { role: string; content: string }[]) => "offline answer"),
  };
}

it("executes three independent contexts with original messages through each question's cutoff", async () => {
  const model = offlineModel();
  const report = await runContextBaselines(options, model);
  expect(report.datasetId).toBe("mnemic-synthetic-v1");
  expect(
    report.rows.map(({ questionId, baseline, sessionIds, status, inputTokens }) => ({
      questionId,
      baseline,
      sessionIds,
      status,
      inputTokens,
    })),
  ).toEqual([
    {
      questionId: options.questionIds[0],
      baseline: "no-memory",
      sessionIds: [],
      status: "answered",
      inputTokens: 2,
    },
    {
      questionId: options.questionIds[0],
      baseline: "sliding-window",
      sessionIds: ["database-decision", "database-proposal"],
      status: "answered",
      inputTokens: 4,
    },
    {
      questionId: options.questionIds[0],
      baseline: "full-context",
      sessionIds: ["database-decision", "database-proposal"],
      status: "answered",
      inputTokens: 4,
    },
    {
      questionId: options.questionIds[1],
      baseline: "no-memory",
      sessionIds: [],
      status: "answered",
      inputTokens: 2,
    },
    {
      questionId: options.questionIds[1],
      baseline: "sliding-window",
      sessionIds: ["database-proposal", "database-correction"],
      status: "answered",
      inputTokens: 4,
    },
    {
      questionId: options.questionIds[1],
      baseline: "full-context",
      sessionIds: ["database-decision", "database-proposal", "database-correction"],
      status: "answered",
      inputTokens: 5,
    },
  ]);
  const chats = model.answer.mock.calls;
  expect(chats).toHaveLength(6);
  const question = database.questions[0]!.text;
  expect(database.questions[1]!.text).toBe(question);
  const source = database.sessions.slice(0, 3).map((session) => session.messages[0].text);
  for (const [index, [messages]] of chats.entries()) {
    expect(messages[0]?.role).toBe("system");
    expect(messages.at(-1)).toEqual({ role: "user", content: question });
    expect(model.countInputTokens.mock.calls[index]?.[0]).toBe(messages);
  }
  expect(chats.map(([messages]) => messages.slice(1, -1))).toEqual(
    [[], source.slice(0, 2), source.slice(0, 2), [], source.slice(1), source].map((texts) =>
      texts.map((content) => ({ role: "user", content })),
    ),
  );
  expect(JSON.stringify(chats)).not.toContain("database-initial");
  expect(JSON.stringify(chats)).not.toContain("offline answer");
  expect(report.rows[5]).toMatchObject({ answer: "offline answer" });
});

it("counts the complete request and skips a full context that exceeds the budget", async () => {
  const model = offlineModel();
  const report = await runContextBaselines(
    { ...options, questionIds: [options.questionIds[1]], inputTokenBudget: 4 },
    model,
  );
  expect(model.countInputTokens).toHaveBeenCalledTimes(3);
  expect(model.answer).toHaveBeenCalledTimes(2);
  expect(report.rows[1]).toMatchObject({ status: "answered", inputTokens: 4 });
  expect(report.rows[2]).toEqual({
    questionId: options.questionIds[1],
    baseline: "full-context",
    sessionIds: ["database-decision", "database-proposal", "database-correction"],
    status: "context-overflow",
    inputTokens: 5,
  });
});

it("runs all 100 questions in dataset order when no selection is specified", async () => {
  const model = offlineModel();
  const report = await runContextBaselines({ inputTokenBudget: 20, windowSessionCount: 1 }, model);
  expect(report.rows).toHaveLength(300);
  expect(model.answer).toHaveBeenCalledTimes(300);
  const expectedQuestions = benchmark.projects.flatMap((project) =>
    project.questions.map((question) => question.id),
  );
  expect(
    report.rows.filter((row) => row.baseline === "full-context").map((row) => row.questionId),
  ).toEqual(expectedQuestions);
});

it.each([
  { ...options, inputTokenBudget: 0 },
  { ...options, windowSessionCount: 1.5 },
  { ...options, questionIds: [] },
  { ...options, questionIds: [options.questionIds[0], options.questionIds[0]] },
  { ...options, questionIds: [options.questionIds[0], "unknown-question"] },
])("validates the whole run before calling the adapter", async (invalid) => {
  const model = offlineModel();
  await expect(runContextBaselines(invalid, model)).rejects.toThrow();
  expect(model.countInputTokens).not.toHaveBeenCalled();
  expect(model.answer).not.toHaveBeenCalled();
});

it("rejects invalid token counts and never turns adapter failures into abstentions", async () => {
  const model = offlineModel();
  model.countInputTokens.mockReturnValueOnce(Number.NaN);
  await expect(runContextBaselines(options, model)).rejects.toThrow("INVALID_CONTEXT_TOKEN_COUNT");
  expect(model.answer).not.toHaveBeenCalled();
  const failure = new Error("offline generation failure");
  model.answer.mockImplementationOnce(() => {
    throw failure;
  });
  await expect(runContextBaselines(options, model)).rejects.toBe(failure);
  expect(model.answer).toHaveBeenCalledTimes(1);
});
