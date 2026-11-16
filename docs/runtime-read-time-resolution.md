# Internal retrieval with read-time context

This #9/#22 slice connects the [replay context builder](read-time-context.md) to internal
`retrieve` calls. It does not install a production binding, unlock management API configuration,
change HTTP request/response contracts, or complete the ablation matrix.

A trusted caller opts in with `readTimeResolution: true`, explicit fusion, topK 1–32, and a
complete `flagsSnapshot`. The snapshot is validated, copied, and frozen before the first await.
The binding does not enable the flag: `read_time_resolution` must also be true in that snapshot.
An absent/false binding retains the existing unsupported-flag rejection. Malformed bindings
fail before database or model access. Configuration cannot come from HTTP or model output.

The first experiment deliberately rejects `memoryBudget` and read-time reinforcement, including
an enabled reinforcement bit in the snapshot. Counting the old value cannot guarantee the size
of an alternative context; silently reinforcing the old shortlist is also inappropriate.
These combinations require separate integration. Existing APIs and write paths continue to
reject `read_time_resolution=true`; `decay` remains unsupported.

## Two distinct result stages

1. Retrieve and score current, active version anchors with existing project/time/source filters.
2. Apply optional reranking to the anchor values, then select Top-K anchors.
3. If read-time resolution is enabled, read and replay those histories once and prepare context.
4. Write the score trace and ID-only replay decisions. No Belief, version, Observation, confidence,
   evidence count, or salience is modified by this experiment.

`candidates`, their values/scores, top-level `abstained`, and existing debug counts retain **anchor
retrieval semantics**. They are not replaced with values that lack those version identities.
The new optional `readTimeContext` is the alternative answer-context stage: its `text`,
`memories`, provenance, outcomes, and `abstained` must be used together by an experimental
consumer. A retracted/unavailable shortlist may therefore have scored anchors while
`readTimeContext.abstained` is true. Old `toMemoryRef`/HTTP citation projections must not be used
to label alternatives as anchor-version content. There is currently no production consumer.

Reranking precedes replay and receives anchor text, not alternative Observation text. This is
an explicit ordering choice, not a claim that alternatives were ranked or rescored. The local
Score API test verifies that ordering and the existing one-call usage accounting.

Scoring and replay are separate SQL statements. The batch history read shares its own MVCC
snapshot and revalidates every anchor as active/current; it does not share the scoring snapshot.
A changed or removed anchor becomes unavailable rather than being revived. Other Observation
changes can be visible at replay time. This is not an as-of or microsecond valid-time resolver.
All source cardinality/transport/JSON limits and context byte limits continue to apply.

## Trace and failure behavior

Shortlisted trace candidates gain `readTimeResolution` containing status, selected Observation
and Evidence IDs (null when unselected/unavailable), and ID/action/relation/reason decisions.
There are no alternative values, display labels, or evidence-text snapshots in this metadata.
Anchor selection/reasons and effective flag snapshots remain intact. Empty or rejected anchor
pools produce an empty context with no history query; flag-off returns the original result and
trace shape without the new fields.

Corrupt history, oversized context, or observed cancellation rejects the operation before trace
insertion, with no partial result or silent fallback to old context. Cancellation does not stop
already-dispatched SQL. Query embedding or Score work may already have incurred cost; there is
no automatic retry, refund, or proof that a provider stopped billing. Existing public chat
fallback behavior is unchanged because no production binding is installed here.

Tests use isolated PostgreSQL, offline models, and a local Score server. They cover both fusion
modes, actual alternative provenance with distinct Evidence, read-only business snapshots,
flag-off SQL counts, empty pools, retraction, strict admission, snapshot mutation, cancellation,
and score-only trace persistence. No paid models, real credentials, or existing services are
used. Real quality metrics, byte/token budget composition, production citations, and the complete
flag matrix remain outstanding; #9/#22 remain open.

Rollback removes the internal binding and trace metadata writer while retaining recorded JSONB
history. There is no migration or global configuration change to reverse.
