import { buildMemoryBenchmark } from "./memory-benchmark.js";

process.stdout.write(JSON.stringify(buildMemoryBenchmark(), null, 2) + "\n");
