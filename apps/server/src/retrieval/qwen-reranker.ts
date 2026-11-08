import {
  MAX_RERANK_RESPONSE_BYTES,
  QWEN_RERANKER_MODEL,
  parseRerankConfig,
  parseRerankInput,
  projectRerankResponse,
  type RerankResult,
} from "./reranker-input.js";

/** Explicit internal API client only. No default endpoint, environment lookup, retry or model hosting. */
export function createQwenReranker(value: unknown) {
  const config = parseRerankConfig(value),
    transport = globalThis.fetch;
  return Object.freeze({
    model: QWEN_RERANKER_MODEL,
    async rerank(value: unknown, callerSignal?: AbortSignal): Promise<RerankResult> {
      const input = parseRerankInput(value);
      if (callerSignal?.aborted) throw Error("RERANK_ABORTED");
      if (input.documents.length === 0)
        return { model: QWEN_RERANKER_MODEL, items: [], usage: null };
      const deadline = performance.now() + config.timeoutMs;
      const timeout = AbortSignal.timeout(config.timeoutMs);
      const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
      const check = () => {
        if (callerSignal?.aborted) throw Error("RERANK_ABORTED");
        if (timeout.aborted || performance.now() >= deadline) throw Error("RERANK_TIMEOUT");
      };
      let rejectAbort!: (error: Error) => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      });
      const onAbort = () =>
        rejectAbort(Error(callerSignal?.aborted ? "RERANK_ABORTED" : "RERANK_TIMEOUT"));
      signal.addEventListener("abort", onAbort, { once: true });
      let response: Response | undefined,
        reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        check();
        const request = transport(config.endpoint, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: QWEN_RERANKER_MODEL,
            text_1: input.query,
            text_2: input.documents.map((d) => d.content),
            use_activation: true,
          }),
        });
        // An injected transport may ignore abort and resolve later; dispose of that body as well.
        void request.then(
          (r) => {
            if (signal.aborted) void r.body?.cancel().catch(() => {});
          },
          () => {},
        );
        response = await Promise.race([request, aborted]);
        check();
        if (response.status !== 200) throw Error("RERANK_FAILED");
        const length = response.headers.get("content-length");
        if (
          !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") ||
          (length !== null &&
            (!/^\d+$/.test(length) || Number(length) > MAX_RERANK_RESPONSE_BYTES)) ||
          !response.body
        )
          throw Error("RERANK_INVALID_RESPONSE");
        reader = response.body.getReader();
        let size = 0;
        const bytes = new Uint8Array(MAX_RERANK_RESPONSE_BYTES);
        for (;;) {
          const result = await Promise.race([reader.read(), aborted]);
          check();
          if (result.done) break;
          if (size + result.value.byteLength > MAX_RERANK_RESPONSE_BYTES)
            throw Error("RERANK_INVALID_RESPONSE");
          bytes.set(result.value, size);
          size += result.value.byteLength;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
          );
        } catch {
          throw Error("RERANK_INVALID_RESPONSE");
        }
        const result = projectRerankResponse(raw, input);
        check();
        return result;
      } catch (error) {
        check();
        const fixed = [
          "RERANK_FAILED",
          "RERANK_INVALID_RESPONSE",
          "RERANK_ABORTED",
          "RERANK_TIMEOUT",
        ];
        throw Error(
          error instanceof Error && fixed.includes(error.message) ? error.message : "RERANK_FAILED",
        );
      } finally {
        signal.removeEventListener("abort", onAbort);
        if (reader) {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        } else if (response?.body && !response.body.locked)
          void response.body.cancel().catch(() => {});
      }
    },
  });
}
