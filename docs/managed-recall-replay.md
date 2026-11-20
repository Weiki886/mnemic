# Managed manual-recall replay

A library instance can opt in with `buildApp({ recallBinding: { fusion, rerankerProvider,
readTimeResolution: true } })`. The replay-aware parser is shared with chat; compatibility
exports retain existing chat assembly interfaces. DB, a 32-byte master key and explicit
persistent daily quota remain prerequisites. Bindings are copied/frozen before registration.
Unknown fields, malformed capability values, credentials and snapshot overrides are rejected.

For each authenticated/project-validated recall, the route captures the effective persisted
snapshot before model/retrieval work. Capability does not enable the flag. Manual recall forces
reinforcement false in that snapshot even when persisted/environment reinforcement is true.
Flag-off emits the old response; flag-on uses actual Observation/Evidence histories.

Root candidates, scores, trace and abstention remain anchor data. The optional read_time_context
contains the actual surviving replay citations and independent abstention. Retracted context
stays empty rather than falling back to the old anchor value. Shared projection checks source
shape, project/anchor consistency, canonical text, uniqueness and byte limits; real history
reading validates nested database references. Chat and recall reuse this projection without a
retrieval-to-chat dependency. Traces retain only source decisions/scores, never alternative values.

Corrupt history or invalid projection returns the existing fixed 500; there is no silent old-value
fallback, automatic retry or new model answer. Authentication, Origin rejection, strict query-only
body, project scope, timeout, no-store, quota and usage rules are unchanged. Embedding/Score work
may already have incurred cost before a later failure; cancellation does not prove stopped billing.
No Belief/Observation/version/salience/evidence-count writes are introduced.

Official startup still installs the base recall binding; its chatReadTimeResolution option is
chat-only. The management API still rejects enabling read_time_resolution. No new request field,
environment setting, schema migration or default change. Shared-database deployments need
consistent capabilities; this is not cluster readiness. #9/#22 remain open for startup recall,
management enablement, real quality metrics and full ablation.

Tests exercise real TCP HTTP with the shared client, isolated PostgreSQL and the committed OpenAPI.
They cover on/off, retraction, corrupt Evidence, strict input, authentication and unbound failure;
model factories are tripwires and business tables are compared before/after. Pure binding and
projection regressions also run. No real credentials or paid Provider requests are used.

Upgrade clients/readers before explicit producers. Disable persisted replay and drain requests
before removing the binding or reverting; retain source-aware readers for existing history.
No migration rollback is needed.
