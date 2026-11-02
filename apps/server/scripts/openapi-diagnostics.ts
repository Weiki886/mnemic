import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { ProblemDetailsSchema } from "@mnemic/shared";
import { RecallRequestSchema, RecallResultSchema } from "@mnemic/shared/memory";
import {
  DoctorInputSchema,
  RecallParamsSchema,
  ReadDoctorReportSchema,
  ProbeDoctorReportSchema,
} from "../src/contracts/diagnostics.js";

export function registerDiagnosticPaths(registry: OpenAPIRegistry) {
  const problem = registry.register("ProblemDetails", ProblemDetailsSchema);
  const read = registry.register("ReadDoctorReport", ReadDoctorReportSchema);
  const probe = registry.register("ProbeDoctorReport", ProbeDoctorReportSchema);
  const recall = registry.register("RecallResult", RecallResultSchema);
  const headers = z.object({ "x-request-id": z.string() });
  const error = (description: string, retry = false) => ({
    description,
    headers: retry ? headers.extend({ "Retry-After": z.string().regex(/^[1-9]\d*$/) }) : headers,
    content: { "application/problem+json": { schema: problem } },
  });
  const common = {
    400: error("Invalid request fields or query; structured field errors when available."),
    401: error("Global operator Bearer required before body parsing and data access."),
    429: error("HTTP IP or authenticated-token request budget exhausted.", true),
    500: error("Unexpected server failure; raw upstream/database errors are not returned."),
  };
  const explicit = {
    403: error("Any Origin header is rejected, including a configured trusted Web origin."),
    413: error("Request body exceeds server limit."),
    415: error("Content-Type must be application/json, optionally with charset."),
  };
  registry.registerPath({
    method: "get",
    path: "/v1/doctor",
    operationId: "readDoctorReport",
    tags: ["Diagnostics"],
    summary: "Read server diagnostics without invoking models",
    description:
      "Always registered. Rejects all query fields; GET cannot enable a probe. Reads database/schema and encrypted Provider config, decrypts keys and constructs SDK adapters to resolve three slots, but never invokes them. Configured model checks are skipped, not successful probes. HTTP200 report.ok=false represents database/configuration errors, including absent DB/master key; HTTP200/ok=true does not prove model availability. Successful handler responses no-store. Not a startup/readiness guarantee.",
    responses: {
      ...common,
      200: {
        description: "Read-only diagnostic report, probe=false; checks may be error or skipped.",
        headers,
        content: { "application/json": { schema: read } },
      },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/doctor/probe",
    operationId: "probeModels",
    tags: ["Diagnostics"],
    summary: "Explicitly probe three model slots; may incur provider charges",
    description:
      "CLI-only explicit action. Rejects every Origin before parsing JSON. Requires JSON empty object; unknown body keys rejected, query keys ignored. With healthy database/dimensions/config, invokes two text slots and one embedding slot concurrently, each maxRetries=0 and 15-second abort signal. Embedding length/finiteness validated. Missing config, upstream failures or model quota denial are caught into HTTP200 probe=true/ok=false reports, not guaranteed HTTP429. Report does not include generated text, keys or raw exceptions. No Evidence/Belief/retrieval trace; invocations may create usage records and consume daily quota. No automatic resend after uncertain response; abort does not prove billing stopped. The abort budget is not an end-to-end database deadline.",
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: DoctorInputSchema, example: {} } },
      },
    },
    responses: {
      ...common,
      ...explicit,
      200: {
        description:
          "Probe report, including per-slot errors rather than propagating provider exceptions.",
        headers,
        content: { "application/json": { schema: probe } },
      },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/projects/{projectId}/recall",
    operationId: "recallMemories",
    tags: ["Memory"],
    summary:
      "Explicitly recall project memory with a persisted retrieval trace; may invoke embedding",
    description:
      "Requires DB/master key; otherwise route absent. Global operator authorization, not per-user project membership. CLI-only: all Origin headers rejected before JSON parsing. Strict body accepts only query, trimmed to1..1000 characters; URL query keys ignored. May send query to embedding Provider and incur charges when vector retrieval enabled. Embedding failure (including quota denial) degrades to keyword route; this is not necessarily HTTP429. Selects active current versions only in this project, topK5. Explicit reinforce=false overrides persistent/env reinforcement, so strength/provenance are unchanged. Persists query text and score-only trace (avoid credentials in queries), returns selected values and up to200 trace candidates plus full candidate_count/truncated. Cross-field selected/reason/count/abstention/flags consistency is a runtime refinement. A30-second signal bounds embedding work, not all SQL. Other failures return fixed500; trace may already exist. No automatic retry.",
    request: {
      params: RecallParamsSchema,
      body: {
        required: true,
        content: {
          "application/json": { schema: RecallRequestSchema, example: { query: "PostgreSQL" } },
        },
      },
    },
    responses: {
      ...common,
      ...explicit,
      404: error("Project does not exist, or route unavailable without DB/master key."),
      200: {
        description:
          "Project-local recalled values or explicit abstention, with persisted non-reinforcing trace.",
        headers,
        content: { "application/json": { schema: recall } },
      },
    },
  });
}
