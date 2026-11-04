import { readFile } from "node:fs/promises";
import { z } from "zod";

const documentSchema = z
  .object({
    openapi: z.literal("3.0.3"),
    info: z
      .object({ title: z.string(), version: z.string(), description: z.string().optional() })
      .passthrough(),
    paths: z.record(z.record(z.unknown())),
    components: z.object({ schemas: z.record(z.unknown()).optional() }).optional(),
  })
  .passthrough();
const operationSchema = z.object({
  operationId: z.string(),
  summary: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  security: z.array(z.unknown()).optional(),
  parameters: z.array(z.unknown()).optional(),
  requestBody: z.unknown().optional(),
  responses: z.record(z.unknown()),
});
const methods = new Set(["get", "head", "post", "put", "patch", "delete", "options"]);
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const anchor = (prefix: string, text: string) => `${prefix}-${encodeURIComponent(text)}`;
const jsonBlock = (value: unknown) =>
  `<pre tabindex="0">${escape(JSON.stringify(value, null, 2))}</pre>`;
const css = `
:root{color-scheme:light;--ink:#18181b;--muted:#52525b;--line:#e4e4e7;--paper:#fff;--soft:#f4f4f5;--get:#0f766e;--patch:#6d28d9;--post:#a16207;--put:#1d4ed8}
*{box-sizing:border-box}html{scroll-padding-top:2rem}body{margin:0;color:var(--ink);background:var(--paper);font:15px/1.65 system-ui,sans-serif}a{color:var(--get);text-underline-offset:3px}a:focus-visible,summary:focus-visible,pre:focus-visible{outline:3px solid var(--patch);outline-offset:4px}header{padding:2.5rem max(1.2rem,calc((100vw - 1360px)/2));border-bottom:1px solid var(--line);background:var(--soft)}.eyebrow{font:12px ui-monospace,monospace;letter-spacing:.08em;color:var(--get)}h1{font:500 clamp(2rem,4vw,3.3rem)/1.2 Georgia,serif;margin:.5rem 0 1rem}h2{font-size:1.5rem;margin:2.5rem 0 1rem}h3{font-size:1.1rem;margin:0}.intro{max-width:78ch;color:var(--muted)}.layout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:3rem;max-width:1360px;padding:1rem 1.2rem 5rem;margin:auto}nav{position:sticky;top:1.5rem;align-self:start;max-height:calc(100vh - 3rem);overflow:auto;padding:.75rem 1rem .75rem 0}nav strong{display:block;margin:1rem 0 .5rem}nav a{display:block;padding:.2rem 0;font-size:.9rem;overflow-wrap:anywhere}.nav-method{font:11px ui-monospace,monospace;color:var(--muted);display:inline-block;width:3.3em}.count{color:var(--muted);font:12px ui-monospace,monospace}.tag{padding-top:.5rem}.operation{border:1px solid var(--line);border-left:4px solid var(--get);border-radius:6px;margin:1rem 0 1.5rem;padding:1.1rem 1.3rem;min-width:0}.operation.post{border-left-color:var(--post)}.operation.put{border-left-color:var(--put)}.operation.patch{border-left-color:var(--patch)}.operation.delete{border-left-color:#b91c1c}.method{font:700 12px ui-monospace,monospace;color:var(--get);margin-right:.8rem}.post .method{color:var(--post)}.put .method{color:var(--put)}.patch .method{color:var(--patch)}.delete .method{color:#b91c1c}code{font:13px ui-monospace,monospace;overflow-wrap:anywhere}.route{margin:.1rem 0 .75rem}.op-note{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--muted)}.security{font:12px ui-monospace,monospace;display:inline-block;border:1px solid var(--line);padding:.1rem .45rem;margin:.3rem 0;color:var(--muted)}details{border-top:1px solid var(--line);padding:.6rem 0}summary{cursor:pointer;font-weight:600;overflow-wrap:anywhere}pre{font:12px/1.65 ui-monospace,monospace;background:var(--soft);padding:1rem;overflow:auto;max-height:32rem;white-space:pre;tab-size:2;border-radius:4px}.schema-index{display:flex;flex-wrap:wrap;gap:.4rem 1rem;margin:1rem 0}.schema{padding:.9rem 0}footer{padding:2rem 0;color:var(--muted);border-top:1px solid var(--line);font-size:.9rem}@media(max-width:800px){.layout{display:block;padding:1rem}nav{position:static;max-height:none;border-bottom:1px solid var(--line);display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 1rem;padding:0 0 1rem}nav strong{grid-column:1/-1}.operation{padding:.9rem}.route code{font-size:12px}header{padding:1.5rem 1rem}pre{max-height:24rem}}`;

/** Read-only HTML from the checked static artifact; never interpolates request or instance data. */
export function renderDocumentation(input: unknown): string {
  const doc = documentSchema.parse(input);
  const groups = new Map<
    string,
    { path: string; method: string; op: z.infer<typeof operationSchema> }[]
  >();
  for (const [path, item] of Object.entries(doc.paths))
    for (const [method, value] of Object.entries(item)) {
      if (!methods.has(method)) continue;
      const op = operationSchema.parse(value),
        tag = op.tags?.[0] ?? "API";
      const group = groups.get(tag) ?? [];
      group.push({ path, method, op });
      groups.set(tag, group);
    }
  const nav = [...groups]
    .map(
      ([tag, ops]) =>
        `<strong><a href="#${anchor("tag", tag)}">${escape(tag)} <span class="count">${ops.length}</span></a></strong>${ops.map(({ method, op }) => `<a href="#${anchor("op", op.operationId)}"><span class="nav-method">${method.toUpperCase()}</span>${escape(op.summary ?? op.operationId)}</a>`).join("")}`,
    )
    .join("");
  const sections = [...groups]
    .map(
      ([tag, ops]) =>
        `<section class="tag" aria-labelledby="${anchor("tag", tag)}"><h2 id="${anchor("tag", tag)}">${escape(tag)}</h2>${ops
          .map(
            ({ path, method, op }) =>
              `<article class="operation ${method}" id="${anchor("op", op.operationId)}"><h3>${escape(op.summary ?? op.operationId)}</h3><p class="route"><span class="method">${method.toUpperCase()}</span><code>${escape(path)}</code></p><span class="security">${op.security?.length === 0 ? "公开 / public" : "Bearer"}</span>${op.description ? `<p class="op-note">${escape(op.description)}</p>` : ""}${op.parameters?.length ? `<details><summary>参数 / parameters</summary>${jsonBlock(op.parameters)}</details>` : ""}${op.requestBody ? `<details><summary>请求体 / requestBody</summary>${jsonBlock(op.requestBody)}</details>` : ""}${Object.entries(
                op.responses,
              )
                .map(
                  ([status, response]) =>
                    `<details><summary>响应 / HTTP ${escape(status)}</summary>${jsonBlock(response)}</details>`,
                )
                .join("")}</article>`,
          )
          .join("")}</section>`,
    )
    .join("");
  const schemas = Object.entries(doc.components?.schemas ?? {});
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mnemic · API reference</title><style>${css}</style></head>
<body><header><div class="eyebrow">MNEMIC / API REFERENCE</div><h1>API 契约参考</h1><p class="intro">只读契约参考 · OpenAPI ${escape(doc.openapi)} · contract ${escape(doc.info.version)}。本页不接收 Token，不发送 API 请求。实例可用接口取决于数据库和模型配置；静态契约不代表服务就绪。</p><a href="docs/openapi.json" download="openapi.json">下载 OpenAPI JSON</a></header><div class="layout"><nav aria-label="API 导航">${nav}<strong><a href="#schemas">Schema 索引</a></strong></nav><main id="main"><p class="intro">按操作查看参数、示例和响应；所有 $ref 定义见 Schema 索引。业务请求仍需 Bearer Token；凭据不要放入 URL。完整接入指南将在后续交付。</p><details><summary>契约概览 / info</summary>${jsonBlock({ openapi: doc.openapi, info: doc.info, servers: doc.servers, security: doc.security, tags: doc.tags })}</details>${sections}<section aria-labelledby="schemas"><h2 id="schemas">Schema 索引</h2><div class="schema-index">${schemas.map(([name]) => `<a href="#${anchor("schema", name)}">${escape(name)}</a>`).join("")}</div>${schemas.map(([name, schema]) => `<details class="schema" id="${anchor("schema", name)}"><summary>${escape(name)}</summary>${jsonBlock(schema)}</details>`).join("")}</section><footer>静态、只读、无自动重试。SSE 的 x-sse-event-schema 是本项目扩展；取消回执不证明供应商停止计费。契约更新后需重启服务以更新本页。</footer></main></div></body></html>`;
}

export async function loadDocumentation(
  url = new URL("../../../../docs/openapi.json", import.meta.url),
) {
  try {
    const json = await readFile(url, "utf8"),
      parsed: unknown = JSON.parse(json);
    return Object.freeze({ json, html: renderDocumentation(parsed) });
  } catch {
    throw new Error("Documentation artifact unavailable");
  }
}
