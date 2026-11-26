# Targeted memory evaluation metrics

These definitions measure write quality, answers about changed or dated facts,
stale memory exposure, and abstention for Issue #12. Record annotations and
outputs for one run, then score them offline.

```bash
pnpm --filter @mnemic/server --silent run eval:memory < annotated-run.json
```

Each metric returns its raw `numerator`, `denominator` and ratio `value`. A zero
denominator produces `null`. For example, a system that returns no memory
context has no measured stale recall rate. Keep missing metrics visible when
comparing runs.

## Definitions

| Metric                       | Formula                                                                                                        | Gold label source                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Write Precision              | Relevant memory writes divided by all memory writes                                                            | Target facts from the benchmark conversations, with evidence IDs and allowed paraphrases                |
| Noise Rate                   | Noise writes divided by all memory writes                                                                      | Source evidence and write rubric, including unsupported, irrelevant and redundant writes                |
| Conflict Resolution Accuracy | Correct responses to answerable conflict questions divided by all answerable conflict questions                | Competing statements and accepted result established by the benchmark author before running the system  |
| Temporal Accuracy            | Correct responses to answerable temporal questions divided by all answerable temporal questions                | Dated evidence with valid intervals, an explicit query time, and a recorded-time cutoff when applicable |
| Stale Recall Rate            | Stale fact occurrences in delivered memory context divided by all fact occurrences in delivered memory context | Superseded or invalidated versions from the annotated timeline at the question's time boundaries        |
| Abstention Accuracy          | Correct answer-or-abstain decisions divided by all evaluated questions                                         | Answerability judgments drawn from the source evidence available at each question's cutoff              |

Lower Noise Rate and Stale Recall Rate are better. Higher values are better for
the other four metrics. Conflict and temporal accuracy count an unwarranted
abstention as an incorrect response. Abstention Accuracy measures the decision
to answer or abstain. Answer correctness is scored separately. The gold
answerability label follows the answerable/unanswerable distinction in
[LongMemEval](https://xiaowu0162.github.io/long-mem-eval/).

## Annotation protocol

The [synthetic project memory benchmark](memory-benchmark.md) supplies a
versioned set of histories and gold question labels for this protocol.

1. Freeze the conversation order, question IDs, visible evidence, expected
   answers, acceptable paraphrases and time boundaries before collecting system
   outputs. Mark each question `general`, `conflict` or `temporal` using its
   primary test objective. Use `expected: "abstain"` when the evidence available
   at the cutoff cannot support an answer.
2. Count each committed semantic memory write once. Give it a unique ID and label
   it `relevant` if it correctly captures a gold target fact or transition.
   Label a useful, supported write outside the target set `neutral`. Label
   unsupported, irrelevant or redundant writes `noise`. Treat retries that
   commit no additional write as a single event with the original write. Score
   distinct redundant writes separately.
3. Assign stable fact-state IDs to assertions or versions in the reference
   timeline. Label a state stale for a question when the evidence at its
   applicable cutoff has superseded or invalidated it and the question does not
   call for that historical state. Build `staleFactIds` from the timeline
   before looking at results or system scores. An earlier state may be valid
   for a historical question and stale for a current one.
4. Record `recalledFactIds` from the memory context actually delivered for
   each question, including repeated false facts under stable annotation IDs.
   Count a fact state once per question and again if it appears in another
   question. Resolve system-specific record IDs to annotation IDs using the
   delivered fact and source evidence. When read-time resolution substitutes
   an Observation, label the delivered fact instead of its ranking anchor.
5. Grade the response against the frozen rubric as `correct`, `incorrect`
   or `abstain`. Require an explicit statement of insufficient evidence and
   no guessed answer for `abstain`. A responding system gets the answerability
   decision right on an answerable question even if it gives an incorrect
   fact. Track execution failures separately so they cannot count as
   abstentions. Preserve the original evidence and resolve disagreements
   before scoring. Use the same rubric, question set and cutoffs for each run.

## Input example

```json
{
  "schemaVersion": 1,
  "writes": [
    { "id": "update-1", "label": "relevant" },
    { "id": "duplicate-1", "label": "noise" }
  ],
  "questions": [
    {
      "id": "current-db",
      "kind": "conflict",
      "expected": "answer",
      "observed": "correct",
      "staleFactIds": ["db-before-update"],
      "recalledFactIds": ["db-after-update", "db-before-update"]
    },
    {
      "id": "db-last-month",
      "kind": "temporal",
      "expected": "answer",
      "observed": "correct",
      "staleFactIds": [],
      "recalledFactIds": ["db-before-update"]
    },
    {
      "id": "unknown-region",
      "kind": "general",
      "expected": "abstain",
      "observed": "abstain",
      "staleFactIds": [],
      "recalledFactIds": []
    }
  ]
}
```

Here the Stale Recall Rate is 1/3. The same earlier state is valid for the
historical question. Write Precision and Noise Rate are both 1/2. The other
three accuracy metrics are 1.

Both arrays are required and at least one must contain a record. The command
accepts up to 8 MiB of UTF-8 JSON, 10,000 writes, 1,000 questions and 200 IDs per
fact list. IDs are case-sensitive ASCII labels of up to 80 characters. Use
letters, digits, periods, underscores and hyphens, starting with a letter or
digit. Write and question IDs are unique within their respective arrays.
Unknown fields, duplicate IDs and inconsistent labels cause exit status 1
with `INVALID_MEMORY_EVALUATION`.

Keep the frozen annotations, run configuration, and source commit alongside
the report for reproduction. The command scores supplied annotations without
opening a database or invoking a model. Baseline execution, survival tests,
costs and ablation runs are separate stages of Issue #12.
