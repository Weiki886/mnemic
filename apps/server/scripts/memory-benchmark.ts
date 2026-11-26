import { scenarios } from "./memory-benchmark-scenarios.js";

const initialValidAt = "2026-01-01T00:00:00.000Z";
const correctionValidAt = "2026-02-01T00:00:00.000Z";
const recentQueryAt = "2026-02-05T00:00:00.000Z";
const historicalQueryAt = "2026-01-15T00:00:00.000Z";

function buildProject([
  id,
  topic,
  original,
  proposal,
  replacement,
  unrecordedQuestion,
]: (typeof scenarios)[number]) {
  function session(stage: string, day: string, text: string) {
    return {
      id: `${id}-${stage}`,
      recordedAt: `${day}T09:00:00.000Z`,
      messages: [{ id: `${id}-${stage}-message`, speaker: "user" as const, text }] as const,
    };
  }

  const initial = session(
    "decision",
    "2026-01-02",
    `The team approved ${original} for ${topic}, effective January 1, 2026.`,
  );
  const proposed = session(
    "proposal",
    "2026-02-06",
    `I proposed ${proposal} for ${topic}. The team has not approved the proposal. Keep the approved choice.`,
  );
  const corrected = session(
    "correction",
    "2026-02-12",
    `Correction: the approved choice for ${topic} is ${replacement}, replacing ${original} effective February 1, 2026. The proposal for ${proposal} was never accepted.`,
  );
  const deleted = session(
    "deletion",
    "2026-03-02",
    `Delete the decision about ${topic} from project memory. That decision is withdrawn and no new choice has been approved.`,
  );
  const firstFact = {
    id: `${id}-initial`,
    value: original,
    validFrom: initialValidAt,
    evidenceId: initial.messages[0].id,
  };
  const replacementFact = {
    id: `${id}-replacement`,
    value: replacement,
    validFrom: correctionValidAt,
    evidenceId: corrected.messages[0].id,
  };

  return {
    id,
    topic,
    sessions: [initial, proposed, corrected, deleted],
    facts: [firstFact, replacementFact],
    questions: [
      {
        id: `${id}-before-correction`,
        kind: "conflict" as const,
        text: `What choice was approved for ${topic} on February 5, 2026?`,
        untilSessionId: proposed.id,
        queryValidAt: recentQueryAt,
        gold: {
          expected: "answer" as const,
          factId: firstFact.id,
          evidenceIds: [firstFact.evidenceId],
          staleFactIds: [],
        },
      },
      {
        id: `${id}-after-correction`,
        kind: "conflict" as const,
        text: `What choice was approved for ${topic} on February 5, 2026?`,
        untilSessionId: corrected.id,
        queryValidAt: recentQueryAt,
        gold: {
          expected: "answer" as const,
          factId: replacementFact.id,
          evidenceIds: [replacementFact.evidenceId],
          staleFactIds: [firstFact.id],
        },
      },
      {
        id: `${id}-historical`,
        kind: "temporal" as const,
        text: `What choice was approved for ${topic} on January 15, 2026?`,
        untilSessionId: corrected.id,
        queryValidAt: historicalQueryAt,
        gold: {
          expected: "answer" as const,
          factId: firstFact.id,
          evidenceIds: [firstFact.evidenceId],
          staleFactIds: [],
        },
      },
      {
        id: `${id}-after-deletion`,
        kind: "general" as const,
        text: `What choice is currently approved for ${topic}?`,
        untilSessionId: deleted.id,
        queryValidAt: null,
        gold: {
          expected: "abstain" as const,
          evidenceIds: [deleted.messages[0].id],
          staleFactIds: [firstFact.id, replacementFact.id],
        },
      },
      {
        id: `${id}-unrecorded`,
        kind: "general" as const,
        text: unrecordedQuestion,
        untilSessionId: corrected.id,
        queryValidAt: null,
        gold: {
          expected: "abstain" as const,
          evidenceIds: [],
          staleFactIds: [],
        },
      },
    ],
  };
}

export function buildMemoryBenchmark() {
  return {
    schemaVersion: 1 as const,
    datasetId: "mnemic-synthetic-v1",
    projects: scenarios.map(buildProject),
  };
}
