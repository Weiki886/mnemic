# Observation-backed replay citations

This #9/#22 slice prepares citation transport and conversation-history reads for read-time
resolution. It does not wire replay into chat generation, enable a flag, add an HTTP request
option, or make the existing response paths produce replay references automatically.

## Reference and response shapes

Existing `messages.memories` UUID strings continue to identify persisted BeliefVersions.
An additional strict reference shape can identify an Observation selected by replay:

```json
{
  "kind": "observation_replay",
  "belief_id": "01920000-0000-7000-8000-000000000001",
  "anchor_version_id": "01920000-0000-7000-8000-000000000002",
  "observation_id": "01920000-0000-7000-8000-000000000003",
  "evidence_id": "01920000-0000-7000-8000-000000000004"
}
```

Only IDs and the discriminator are stored. No value, label, prompt or evidence text is accepted
in a replay reference. UUIDs normalize to lowercase. More than 32 non-string references in a
message causes its replay references to be omitted; valid legacy UUID entries remain readable.
Malformed or unavailable entries are omitted individually, as with existing legacy bad IDs.
This is not a new write API or an authorization grant to create arbitrary references.

A resolved replay citation retains `belief_id`, subject, attribute and the original Observation
value, but has `belief_version_id: null`. Its `provenance` contains kind, anchor_version_id,
observation_id and evidence_id. Null explicitly says the alternative value is not a stored
BeliefVersion. The anchor must not be presented as that value's version. Actual JSON null values
remain facts, distinct from a missing citation.

Shared JSON, SSE finish, conversation detail and resume schemas accept the new variant, and
the committed OpenAPI follows those schemas. Legacy UUID-backed responses keep their original
shape; legacy JSON parsing still strips unknown version-citation fields, while SSE remains
strict. Older clients that require a non-null version ID cannot decode the new variant. Current
production writers still emit only old references; future activation must use updated clients.
CLI prints the actual Observation/Evidence IDs. Web history marks replay sources and retains
navigation to the Belief detail, whose current value may differ from this historical citation.

## Read-time integrity

The reader never trusts JSONB membership as a foreign-key or project guarantee. Batched queries
verify both the anchor version and referenced Belief belong to the current project, the
Observation matches that Belief's project/subject/attribute, and its actual Evidence message
belongs to a conversation in the same project. The stored Evidence ID must match the Observation.
Missing/mismatched anchors, groups, Evidence and extra object fields cannot resolve content.

Reads resolve the original immutable Observation, not a fresh replay or the anchor's value.
An anchor may be historical or no longer current. Display and resume may show deleted/retracted
history; model-history injection filters non-active Beliefs for both reference variants. Historical
citations remain historical context, not new system facts. Existing inherited-message scope and
file-parent validation still run first. These lookups do not promise a shared snapshot across
queries or reconstruct an as-of state; canonical rows are checked at read time.

There is one batched version lookup and, only for replay references, one additional batched
Observation/Evidence lookup across all messages. No per-message database queries are added.
No migration or content backfill is needed: the existing JSONB column already accepts these
references. There is no new copy of Evidence, BeliefVersion or Observation data.

## Validation and rollout

Tests use an isolated PostgreSQL database, real authenticated HTTP, committed OpenAPI validation,
poisoned nested references, mixed-order history, inherited messages, null values and inactive
Beliefs. A cross-project Evidence predicate mutation must fail its negative test. Browser and
CLI checks distinguish actual Observation sources from persisted version citations.

No real Provider configuration or model request is used. Production chat/recall consumption,
management enablement, default-on reranking, real quality metrics and the complete ablation
matrix remain outside this slice. #9/#22 remain open.

Rollback the reader/schema changes before introducing any replay writer. After a future writer
exists, older readers would silently omit object references, so deployment order must update
readers/clients before enabling new writers. No database rollback is needed.
