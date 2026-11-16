import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { memoryContent, renderMemoryContext } from "./context-budget.js";
import { readReadTimeReplays } from "./read-time-history.js";

export interface ReplayContextMemory {
  subject: string;
  attribute: string;
  value: unknown;
  provenance: {
    kind: "observation_replay";
    projectId: string;
    beliefId: string;
    anchorVersionId: string;
    observationId: string;
    evidenceId: string;
    validFrom: string;
  };
}

/** Internal context preparation only; never convert provenance into a legacy version citation. */
export async function buildReadTimeContext(
  db: Pick<PostgresJsDatabase, "execute">,
  scope: unknown,
  signal?: AbortSignal,
) {
  const check = () => {
    if (signal?.aborted) throw Error("READ_TIME_CONTEXT_ABORTED");
  };
  check();
  const rows = await readReadTimeReplays(db, scope);
  check();
  const memories: ReplayContextMemory[] = [];
  const contents: string[] = [];
  const outcomes = rows.map((row) => {
    if (row?.selected) {
      const selected = row.selected;
      const memory: ReplayContextMemory = {
        subject: row.subject,
        attribute: row.attribute,
        value: selected.value,
        provenance: {
          kind: "observation_replay",
          projectId: row.projectId,
          beliefId: row.beliefId,
          anchorVersionId: row.anchorVersionId,
          observationId: selected.observationId,
          evidenceId: selected.evidenceId,
          validFrom: selected.validFrom.toISOString(),
        },
      };
      const content = memoryContent(memory);
      if (Buffer.byteLength(content, "utf8") > 16384) throw Error("READ_TIME_CONTEXT_TOO_LARGE");
      memories.push(memory);
      contents.push(content);
    }
    return {
      beliefId: row?.beliefId ?? null,
      anchorVersionId: row?.anchorVersionId ?? null,
      status: !row
        ? ("unavailable" as const)
        : row.selected
          ? ("selected" as const)
          : ("unselected" as const),
      decisions: row?.decisions ?? [],
    };
  });
  const text = renderMemoryContext(contents);
  if (Buffer.byteLength(text, "utf8") > 65536) throw Error("READ_TIME_CONTEXT_TOO_LARGE");
  check();
  return { text, memories, outcomes, abstained: memories.length === 0 };
}
