const MAX_INPUT_BYTES = 8 * 1024 * 1024;

export async function runEvaluation(score: (input: unknown) => object, errorCode: string) {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_INPUT_BYTES) throw new Error("Evaluation exceeds the input limit");
      chunks.push(bytes);
    }
    const input = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
    const report = score(JSON.parse(input));
    process.stdout.write(JSON.stringify(report) + "\n");
  } catch {
    process.stderr.write(errorCode + "\n");
    process.exitCode = 1;
  }
}
