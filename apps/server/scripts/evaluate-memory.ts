import { runEvaluation } from "./evaluation-cli.js";
import { scoreMemoryMetrics } from "./memory-metrics.js";

await runEvaluation(scoreMemoryMetrics, "INVALID_MEMORY_EVALUATION");
