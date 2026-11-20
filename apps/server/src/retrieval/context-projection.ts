import { ReplayCitedMemorySchema, type CitedMemory } from "@mnemic/shared/chat";
import type { RetrieveResult } from "./search.js";
import { memoryContent, renderMemoryContext } from "./context-budget.js";

export type AnswerMemory = CitedMemory & { value: unknown };

/** One projection for prompt, response and persistence. Never cite an anchor as a replayed value. */
export function projectRetrievalContext(
  result: RetrieveResult,
  projectId: string,
): { memories: AnswerMemory[]; abstained: boolean } {
  if (result.readTimeContext === undefined)
    return {
      memories: result.candidates.map((c) => ({
        belief_id: c.beliefId,
        belief_version_id: c.beliefVersionId,
        subject: c.subject,
        attribute: c.attribute,
        value: c.value,
      })),
      abstained: result.abstained,
    };
  try {
    const context = result.readTimeContext;
    if (!context || !Array.isArray(context.memories) || context.memories.length > 32) throw Error();
    const ids = new Set<string>();
    const memories = context.memories.map((m) => {
      const p = m.provenance;
      if (
        p.kind !== "observation_replay" ||
        p.projectId !== projectId ||
        ids.has(p.anchorVersionId) ||
        !result.candidates.some(
          (c) => c.beliefId === p.beliefId && c.beliefVersionId === p.anchorVersionId,
        )
      )
        throw Error();
      ids.add(p.anchorVersionId);
      return {
        ...ReplayCitedMemorySchema.parse({
          belief_id: p.beliefId,
          belief_version_id: null,
          subject: m.subject,
          attribute: m.attribute,
          value: m.value,
          provenance: {
            kind: p.kind,
            anchor_version_id: p.anchorVersionId,
            observation_id: p.observationId,
            evidence_id: p.evidenceId,
          },
        }),
        value: structuredClone(m.value),
      };
    });
    const contents = memories.map(memoryContent);
    const text = renderMemoryContext(contents);
    if (
      text !== context.text ||
      context.abstained !== (memories.length === 0) ||
      Buffer.byteLength(text, "utf8") > 65536 ||
      contents.some((s) => Buffer.byteLength(s, "utf8") > 16384)
    )
      throw Error();
    return { memories, abstained: context.abstained };
  } catch {
    throw Error("INVALID_REPLAY_ANSWER_CONTEXT");
  }
}
