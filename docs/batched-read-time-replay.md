# Batched read-time replay preparation

This #9/#22 slice extends the read-only [Observation replay foundation](read-time-replay.md).
It does not enable `read_time_resolution`, change public contracts, persist traces, or inject
alternative values into chat. Those integration and evaluation steps remain outstanding.

`readReadTimeReplays(db, { projectId, anchors, authorityEnabled })` accepts up to 32 distinct
`{ beliefId, beliefVersionId }` anchors. Both identity sets must be unique, including after UUID
case normalization. Input is validated and copied before the first await. An empty, otherwise
valid batch returns `[]` without database access. Unknown fields or invalid input fail with
`INVALID_READ_TIME_SCOPE`; there is no HTTP configuration source for this internal API.

A single SQL statement uses a requested-anchor CTE and bounded LATERAL histories. All results
share one MVCC snapshot, without separate per-anchor round trips. Each anchor must independently
match project, active/current Belief, version ownership, open recorded interval, and source group.
Every historical Evidence is checked through message and conversation ownership. Event order
retains PostgreSQL microseconds; effective-time policy comparisons retain the existing Date
millisecond semantics.

The array follows input order, with null slots for missing or ineligible anchors. Each group
has its own 200-event limit and 201st-row overflow sentinel; 300 events spread across two valid
groups do not hit an accidental global limit. A corrupt or oversized eligible history rejects
the entire batch with `INVALID_READ_TIME_HISTORY`; no partial array is returned. SQL failures
remain `READ_TIME_HISTORY_FAILED`, without raw exceptions or query content.

The source additionally limits PostgreSQL JSON-text transport to 16 KiB per value and 128 KiB
per group. Oversized payloads are replaced with null plus a rejection flag before being returned;
that placeholder is never interpreted as a fact. The reducer still enforces its separate 64 KiB
compact-JSON total and depth limit. The coarse transport ceiling accommodates ordinary PostgreSQL
array/object separator overhead, but unusually verbose numeric representations can hit this new
ceiling even when their parsed JavaScript representation would fit the reducer budget. This
additional fail-closed boundary also applies to the single-anchor wrapper.

At most 32 bounded histories are loaded, not the entire project. These bounds do not guarantee
constant-cost group discovery, ordering, JSON serialization, or query execution; large-table
performance has not been measured. A batch may still be rejected after SQL if local validation
fails. There are no locks, model invocations, business writes, migrations, or new dependencies.

`readReadTimeReplay` delegates to the same implementation and retains its single-result/null
shape and fixed error categories. Results retain actual Observation/Evidence references;
`anchorVersionId` remains only the admission anchor, never the identity of a substituted value.
Production provenance projection, flag snapshots, traces, and chat/recall wiring are still needed.

Tests use real isolated PostgreSQL databases and cover one-query batching, empty batches,
32/33 boundaries, duplicate identities, per-group limits, cross-project exclusion, corruption,
input mutation, payload omission, and unchanged business snapshots. Existing single-anchor
and pure replay tests remain in the suite. Rollback restores the single-anchor implementation;
there is no database or configuration rollback.
