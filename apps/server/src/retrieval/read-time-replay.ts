import { z } from "zod";
import { CandidateSchema } from "../extraction/schema.js";
import { AssertionIntentPolicy } from "../resolver/intent-policy.js";
import { decideRelation, type PolicyOutcome } from "../resolver/policies.js";
import { classifyValues } from "../resolver/value-compare.js";

export const MAX_REPLAY_OBSERVATIONS = 200;
const Group = z
  .object({
    projectId: z.string().uuid().toLowerCase(),
    subject: z.string().min(1),
    attribute: z.string().min(1),
  })
  .strict();
const Observation = Group.extend({
  id: z.string().uuid().toLowerCase(),
  evidenceId: z.string().uuid().toLowerCase(),
  value: z.unknown(),
  authority: z.number().int().min(-32768).max(32767),
  assertionIntent: CandidateSchema.shape.assertion_intent,
  sourceType: CandidateSchema.shape.source_type,
  validTime: z.date().nullable(),
  recordedAt: z.date(),
}).strict();
const Input = z
  .object({
    group: Group,
    observations: z.array(Observation).min(1).max(MAX_REPLAY_OBSERVATIONS),
    authorityEnabled: z.boolean(),
  })
  .strict();
export interface ReplayDecision {
  observationId: string;
  action: "create" | "ignore" | "retract" | "proceed";
  relation: PolicyOutcome["relation"] | null;
  reason: PolicyOutcome["detail"]["reason"];
  previousObservationId: string | null;
  resultObservationId: string | null;
}

/** Internal, detached value calculation only. The source must provide complete PG chronological order. */
export function replayObservationGroup(value: unknown) {
  const invalid = () => Error("INVALID_READ_TIME_REPLAY");
  let input: z.infer<typeof Input>;
  try {
    if (!value || typeof value !== "object") throw invalid();
    const raw = (value as Record<string, unknown>).observations;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_REPLAY_OBSERVATIONS)
      throw invalid();
    let bytes = 0;
    const values = raw.map((o) => {
      // JSONB data only: don't silently turn undefined, non-finite numbers or callbacks into null.
      const text = JSON.stringify(o.value, (_key, v: unknown) => {
        if (
          ["undefined", "function", "symbol", "bigint"].includes(typeof v) ||
          (typeof v === "number" && !Number.isFinite(v))
        )
          throw invalid();
        return v;
      });
      if (text === undefined) throw invalid();
      const size = Buffer.byteLength(text, "utf8");
      bytes += size;
      if (size > 16384 || bytes > 65536) throw invalid();
      const detached: unknown = JSON.parse(text);
      // Bound recursive value comparison as well as serialized size.
      const pending = [{ value: detached, depth: 0 }];
      while (pending.length) {
        const item = pending.pop()!;
        if (item.depth > 32) throw invalid();
        if (item.value !== null && typeof item.value === "object")
          for (const child of Object.values(item.value))
            pending.push({ value: child, depth: item.depth + 1 });
      }
      return detached;
    });
    input = Input.parse(value);
    input.observations.forEach((o, i) => {
      o.value = values[i];
    });
    const ids = new Set<string>();
    for (const [i, o] of input.observations.entries()) {
      if (
        o.projectId !== input.group.projectId ||
        o.subject !== input.group.subject ||
        o.attribute !== input.group.attribute ||
        ids.has(o.id) ||
        (i > 0 && o.recordedAt < input.observations[i - 1]!.recordedAt)
      )
        throw invalid();
      ids.add(o.id);
    }
  } catch {
    throw invalid();
  }

  let current: z.infer<typeof Observation> | null = null;
  let established = false;
  const decisions: ReplayDecision[] = [];
  const intent = new AssertionIntentPolicy();
  for (const incoming of input.observations) {
    const previous = current;
    const valueRelation = previous ? classifyValues(previous.value, incoming.value) : "conflict";
    const verdict = intent.decide({
      intent: incoming.assertionIntent,
      sourceType: incoming.sourceType,
      valueRelation,
    });
    let action: ReplayDecision["action"] =
      verdict.action === "proceed" ? "proceed" : verdict.action;
    let relation: ReplayDecision["relation"] = null;
    let reason: ReplayDecision["reason"] = null;
    if (incoming.assertionIntent !== "RETRACT" && !established) {
      // The first fact creates a Belief before Resolver's conflict gate in the write pipeline.
      current = incoming;
      established = true;
      action = "create";
    } else if (verdict.action === "retract") {
      current = null;
      established = true;
    } else if (verdict.action === "proceed") {
      if (previous) {
        const outcome = decideRelation({
          authorityEnabled: input.authorityEnabled,
          incomingAuthority: incoming.authority,
          currentAuthority: previous.authority,
          incomingValidFrom: incoming.validTime ?? incoming.recordedAt,
          currentValidFrom: previous.validTime ?? previous.recordedAt,
          currentValidTo: null,
          valueRelation,
        });
        relation = outcome.relation;
        reason = outcome.detail.reason;
      } else relation = "supersede";
      if (relation === "extend" || relation === "supersede") current = incoming;
    }
    decisions.push({
      observationId: incoming.id,
      action,
      relation,
      reason,
      previousObservationId: previous?.id ?? null,
      resultObservationId: current?.id ?? null,
    });
  }
  return {
    selected: current
      ? {
          observationId: current.id,
          evidenceId: current.evidenceId,
          value: current.value,
          validFrom: new Date(current.validTime ?? current.recordedAt),
        }
      : null,
    decisions,
  };
}
