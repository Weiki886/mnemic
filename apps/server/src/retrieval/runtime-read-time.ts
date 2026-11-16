import { createFeatureFlagSnapshot } from "@mnemic/shared/flags";
import type { RetrieveOptions } from "./search.js";

/** Trusted experiment binding, never an HTTP or model-selected option. Does not enable flags. */
export function captureReadTimeBinding(options: RetrieveOptions, hasFusion: boolean, topK: number) {
  if (options.readTimeResolution === undefined || options.readTimeResolution === false)
    return undefined;
  try {
    if (
      options.readTimeResolution !== true ||
      !hasFusion ||
      options.flagsSnapshot === undefined ||
      options.memoryBudget !== undefined ||
      options.reinforce === true ||
      !Number.isInteger(topK) ||
      topK < 1 ||
      topK > 32
    )
      throw Error();
    const snapshot = createFeatureFlagSnapshot(options.flagsSnapshot);
    if (snapshot.flags.read_time_reinforcement) throw Error();
    return snapshot;
  } catch {
    throw Error("INVALID_READ_TIME_RETRIEVAL_OPTIONS");
  }
}
