# Trusted chat consumption of replay context

This #9/#22 slice consumes `retrieve.readTimeContext` in shared answer preparation. A trusted
library assembly can inject a `retrieveFn` that explicitly supplies the existing read-time
binding, fusion and complete flag snapshot. There is no new HTTP field, startup option,
management capability, default flag change or implicit experiment activation.

When the result contains replay context, JSON and SSE use its surviving memories and abstention
for the prompt, response and assistant-message references. Ranked anchors remain retrieval/trace
identities; their old values are not injected or cited as alternative facts. Budgeted-out,
retracted and unavailable context cannot fall back to anchor values. Without replay context,
the existing prompt and UUID-only citation path remains unchanged.

The answer projection validates project and shortlisted anchor membership, unique anchors,
reference shape, canonical rendered text, abstention and byte bounds. It detaches selected values
before model waits. This consistency check is not an authorization boundary for arbitrary HTTP
context: `retrieveFn` is trusted injected code, and the real replay reader remains responsible
for database project/group/Evidence validation. The canonical renderer preserves the exact
numbered block used for token counting. No extra token estimate is introduced.

Replay citations have a null version ID and actual Observation/Evidence provenance. Persistence
projects only their strict ID references into `messages.memories`; no values, labels or text are
copied. Both JSON and SSE persist and return the same selected sources. The #148 history reader
resolves those references on later display/resume/model history. Update readers/clients before
enabling any trusted producer; old clients cannot decode null-version citations.

An invalid context follows existing retrieval-failure behavior: degrade to no-memory chat, never
old-anchor context. A chat model call can therefore still incur cost. Existing cancellation,
stream interruption, persistence acknowledgements and background writeback remain in force.
This is not a quality claim, proof of stopped billing, or complete model-window budget.

Tests use isolated PostgreSQL and offline SDK models. They exercise real retrieval/replay,
JSON answer orchestration and SSE routing, canonical prompts, actual source references,
ID-only storage, unchanged facts/versions, budget/retraction, malformed context and flag-off
compatibility. No real credentials or paid Provider requests are used.

Formal chat/recall bindings, management enablement, default-on reranking, real quality metrics
and the full ablation matrix remain outstanding. #9/#22 stay open. Rollback removes the
trusted experiment consumer before disabling the replay-aware readers; no migration is needed.
