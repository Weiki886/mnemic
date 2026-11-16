# Provenance-aware replay context

This #9/#22 slice adds internal `buildReadTimeContext(db, scope, signal?)` preparation on top of
the [batch replay source](batched-read-time-replay.md). It does not wire chat/recall, change
public protocols, enable `read_time_resolution`, call models, or persist results or traces.

The scope is exactly the existing batch scope: project ID, at most 32 unique Belief/version
anchors, and the captured authority setting. Caller-supplied values or display fields are rejected.
The source validates and copies this scope before its first await, obtains all eligible histories
in one SQL snapshot, and supplies authoritative project/subject/attribute metadata alongside the
selected Observation. Existing project, active/current, Evidence ownership, cardinality, JSON,
and time-precision boundaries remain in force. A failed history rejects the complete operation.

The result separates three representations:

- `memories` contains the selected subject, attribute, value, and discriminated provenance:
  `kind: observation_replay`, projectId, beliefId, anchorVersionId, observationId, evidenceId,
  and the selected validFrom in ISO form. The anchor version is not the source version of an
  alternative value; there is deliberately no legacy beliefVersionId citation field.
- `text` uses the existing `memoryContent` and `renderMemoryContext` functions, so numbering,
  separators, JSON formatting, and the empty marker share the chat renderer. Unavailable or
  retracted entries are omitted and the remaining entries are renumbered in input order.
- `outcomes` retains aligned selected/unselected/unavailable statuses and ID-only decisions.
  It contains no values or subject/attribute labels and is not written to a trace. Missing
  source results have null identity fields rather than fabricated accepted references.

A selected JSON null is still a fact; a null selected record means no selected value (including retracted or ignored-only histories). When no memory
survives, the result uses the canonical empty marker and `abstained: true`. This local flag is
not a promise that a future model will abstain in its generated answer.

Each rendered entry is limited to 16 KiB and the whole numbered block to 64 KiB of UTF-8,
including actual numbering and separators. Over-limit results fail as a whole with
`READ_TIME_CONTEXT_TOO_LARGE`; nothing is truncated or partially returned. These are byte safety
limits, not token counts, a selected model tokenizer, or a full context-window guarantee.
No new prompt-injection, secret-detection, or automatic-redaction guarantee is introduced.

Cancellation is checked before source access, after SQL completes, and before returning the
context. Observed cancellation produces fixed `READ_TIME_CONTEXT_ABORTED`, without its reason.
It does not cancel SQL already dispatched or prove a database query has stopped. There are no
model calls to cancel here. Source errors retain the existing fixed categories.

Tests use isolated PostgreSQL databases and compare actual rendered text and provenance against
stored version/Evidence data. They cover null/retracted/missing results, detached inputs, strict
scope, cancellation, UTF-8 entry limits, and the exact 64 KiB numbered boundary. The entry is
internal and has no production consumer; API/client citation evolution, flag snapshots, runtime
injection, trace persistence, and evaluation remain outstanding. #9/#22 remain open.

Rollback removes the context builder and added source metadata; no migration or configuration
rollback is needed. Existing single/batch replay behavior and canonical renderers are retained.
