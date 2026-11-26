# Synthetic project memory benchmark

Export the first version of the Issue #12 question set:

```bash
pnpm --filter @mnemic/server --silent run eval:dataset > mnemic-synthetic-v1.json
```

The export contains 20 independent synthetic project histories and 100
questions. Each history includes an approved technical choice, a competing
proposal, a retroactive correction, and an explicit withdrawal and deletion
request. The same question patterns are applied to 20 authored topics.
Questions within a project share evidence and should be treated as related
observations.

| Question pattern                   | Cases | Ground truth                                                                                                |
| ---------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------- |
| Before the correction is recorded  |    20 | Use the original choice given the evidence visible at the cutoff. The conflicting proposal has no approval. |
| After the correction is recorded   |    20 | At the same effective date, use the newly recorded correction. The original choice is stale.                |
| Historical lookup after correction |    20 | At the earlier effective date, the original choice is valid.                                                |
| After deletion                     |    20 | Abstain. Both previously approved choices are stale for the current question.                               |
| Unrecorded detail                  |    20 | Abstain. The visible record never answers the question.                                                     |

## Using the export

- Select a project and replay its `sessions` in order through the question's
  `untilSessionId`, inclusive. Each session has a `recordedAt` timestamp and
  original `messages` with stable evidence IDs. Replay each question against
  its prescribed prefix so later sessions and earlier evaluation answers
  cannot influence it.
- Give the responding system the question's `text`. When the baseline
  supports an explicit effective-time parameter, use `queryValidAt`.
  A null value indicates a current or non-temporal question. The session
  cutoff defines the record available to the system even when the question
  text and effective date are identical across two probes.
- Keep `facts` and `gold` with the evaluator. Each fact identifies an
  approved choice, its effective start and supporting evidence. The gold
  answer references the expected fact ID. An abstention label either
  references the deletion message or has no evidence IDs when the requested
  detail is absent. Use the gold labels to grade observed responses and
  map delivered memory to the stable fact IDs for
  [targeted metrics](metrics.md).

The export is deterministic and requires no model, credentials or database.
Keep the dataset ID and source commit with a run. This dataset provides a
repeatable synthetic reference for baseline development. Real project traces,
baseline execution, cost measurements and the Memory Survival Test are
separate evaluation work.
