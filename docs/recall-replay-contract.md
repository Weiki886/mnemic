# Replay-aware recall response

Recall returns optional `read_time_context` when a trusted recall binding and the persisted
read-time resolution flag are both enabled. Library instances can install this capability
through [managed recall](managed-recall-replay.md). Official startup can install it through
`recallReadTimeResolution: true` in the [retrieval profile](startup-retrieval-binding.md).
The flag is off by default.

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
A schema-valid ID is not database authorization; the managed producer validates project and
Evidence ownership before constructing the response.

When replay context is present, CLI displays actual replay sources and its local abstention,
then labels the existing score section as anchor scores. It does not print old anchor values
as current facts, including when replay is empty. No new request, retry, model call or automatic
fallback is introduced. Without the extension CLI output remains unchanged. Source fields pass
through the existing terminal sanitizer and value preview bound.

Older strict clients reject the extension; update clients before activating a producer.
Disable persisted replay and drain requests before removing producer capability; remove
producers before reverting clients. Shared schema/client tests and independent Ajv validation of the committed
OpenAPI use offline fixtures only. No real Provider or paid request is used.

Management capability readiness, default-on reranking, quality metrics and complete ablation
remain future work. #9/#22 stay open.
