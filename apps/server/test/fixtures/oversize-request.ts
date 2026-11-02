import { request } from "node:http";

/** Probe Fastify's declared-length admission over real TCP, without racing a rejected upload.
 * Wait for the final response even if Node sends an interim 100. No body, resend or retry.
 * Complete oversized payloads are separately tested with app.inject.
 */
export function requestOversizeHeaders(
  url: string,
  headers: NonNullable<RequestInit["headers"]>,
  declaredBytes: number,
  method = "POST",
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method,
        headers: {
          ...Object.fromEntries(new Headers(headers)),
          "content-length": String(declaredBytes),
          expect: "100-continue",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("error", reject);
        res.on("end", () => {
          const responseHeaders = new Headers();
          for (let i = 0; i < res.rawHeaders.length; i += 2)
            responseHeaders.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode!,
              headers: responseHeaders,
            }),
          );
          req.destroy();
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(5_000, () => req.destroy(new Error("oversize header probe timed out")));
    req.flushHeaders();
  });
}
