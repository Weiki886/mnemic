# Replay-aware recall response preparation

This #9/#22 slice prepares an optional `read_time_context` response and CLI projection for
future trusted recall replay. It does not install a producer, change the recall route/binding,
open configuration management, or activate a persisted flag. The current handler still emits
its original response. HTTP request fields and default behavior are unchanged.

Root `candidates`, `abstained` and score-only `trace` continue to describe ranked current-version
anchors. They must not be relabeled as alternative Observation values. Optional read_time_context
contains only its own abstained state and up to five replay memories using the shared citation
contract: null belief_version_id plus actual Observation/Evidence and anchor references.
This is response content, not a content snapshot stored in a retrieval trace.

Runtime validation requires an explicit trace flag snapshot with read_time_resolution=true,
consistent local abstention, unique anchor references and matching selected Belief/version pairs.
Unknown fields, missing values and malformed provenance are rejected. JSON null is still a fact.
OpenAPI describes the structural extension, including null-only versions; cross-field membership
and flag/abstention rules are runtime refinements and are not claimed as OpenAPI-only guarantees.
A schema-valid ID is not database authorization; the future producer must validate project and
Evidence ownership before constructing the response.

When replay context is present, CLI displays actual replay sources and its local abstention,
then labels the existing score section as anchor scores. It does not print old anchor values
as current facts, including when replay is empty. No new request, retry, model call or automatic
fallback is introduced. Without the extension CLI output remains unchanged. Source fields pass
through the existing terminal sanitizer and value preview bound.

Older strict clients reject the extension; update clients before activating a future producer.
Rollback this preparation before producer activation; afterwards remove producers before
reverting clients. Shared schema/client tests and independent Ajv validation of the committed
OpenAPI use offline fixtures only. No real Provider or paid request is used.

Formal recall binding/route consumption, startup selection, management capability readiness,
default-on reranking, quality metrics and complete ablation remain future work. #9/#22 stay open.

The subsequent [managed recall producer](managed-recall-replay.md) now emits this extension
only for explicitly assembled library instances with the persisted replay flag enabled.
Default and startup-created recall bindings retain the original output.
