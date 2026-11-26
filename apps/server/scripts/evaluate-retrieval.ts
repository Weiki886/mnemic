import { runEvaluation } from "./evaluation-cli.js";
import { scoreRetrievalComparison } from "./retrieval-comparison.js";

await runEvaluation(scoreRetrievalComparison, "INVALID_RETRIEVAL_COMPARISON");
