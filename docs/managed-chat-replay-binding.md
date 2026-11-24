# Managed chat replay capability

A library instance can explicitly install `buildApp({ chatRetrievalBinding })` with the existing
fusion/rerankerProvider configuration plus optional `readTimeResolution: true`. The parser
copies and freezes all configuration before app startup and keeps the existing fixed
`INVALID_RECALL_BINDING` error contract. False, null, strings, flag snapshots, credentials,
reinforcement or Top-K overrides are not accepted in this binding.

This is a capability, not activation. For each chat operation, shared JSON/SSE answer preparation
captures the persisted flag snapshot before embedding/reranking/model work, allowing read-time
resolution for that retrieval only. The same frozen snapshot is passed through retrieval and
trace creation. When the persisted flag is off, history replay is skipped and existing anchor
context/citations remain in use. The binding itself performs no database/model access, writes
no flags and does not change a revision.

The existing DB/master-key/persistent daily-quota prerequisites remain mandatory. Installing a
capability does not verify Provider readiness or reserve quota; actual requests use existing
admission/accounting. Unsupported flag combinations, including reinforcement with this replay
binding, follow the existing retrieval-failure/no-memory chat degradation; a chat model call
may still occur. There is no old-anchor fallback for invalid replay context.

[Official startup](startup-retrieval-binding.md) installs chat replay when the retrieval profile
sets `chatReadTimeResolution: true`. The separate `recallReadTimeResolution` option installs
[managed recall replay](managed-recall-replay.md). The management API still rejects enabling
`read_time_resolution`. A trusted experiment must arrange its persisted configuration separately,
and instances sharing the database need consistent capabilities.

Tests use isolated PG and offline SDK models: real JSON/SSE routes, no retrieveFn substitution,
persisted flag-on replay and flag-off old behavior, immutable binding capture, strict malformed
options and legacy compatibility. No real Provider credentials or paid network calls are used.

Management readiness, real quality metrics and full ablation remain outstanding under #9/#22.
Keep replay-aware readers until rollback has removed all producer instances.

Write operations record the read-time-resolution snapshot without executing replay, just as
they already do for reranker. This keeps legacy/durable extraction and manual writes usable
while a trusted read experiment is enabled. Unbound reads and unsupported decay remain rejected.
