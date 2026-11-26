# Paired retrieval evaluation

Compare two recorded rankings against the same relevance labels. A pair can
compare reranking off and on, or two fusion configurations. The command reads
one JSON document from stdin and writes one JSON report. It runs offline and
requires no database, Provider configuration, or model credentials.

```bash
pnpm --filter @mnemic/server --silent run eval:retrieval < paired-rankings.json
```

An input file contains a cutoff and one entry per query. This example labels one
version as relevant and gives its rank in each run.

```json
{
  "k": 1,
  "cases": [
    {
      "id": "project-database",
      "relevantVersionIds": ["10000000-0000-7000-8000-000000000001"],
      "baseline": {
        "traceId": "20000000-0000-7000-8000-000000000001",
        "rankedVersionIds": ["10000000-0000-7000-8000-000000000002"]
      },
      "variant": {
        "traceId": "20000000-0000-7000-8000-000000000002",
        "rankedVersionIds": ["10000000-0000-7000-8000-000000000001"]
      }
    }
  ]
}
```

Record the selected `beliefVersionId` values in the order returned by retrieval
and include each run's trace ID. Keep the query, corpus, labels, cutoff and
unrelated settings fixed within each pair. Capture at least K results when
available. An empty ranking indicates abstention. Use an empty
`relevantVersionIds` only for deliberately unanswerable queries.

- **Hit@K** is 1 when at least one relevant version appears in the first K results.
- **Recall@K** divides relevant results in the first K by all labeled relevant versions.
- **MRR@K** is the reciprocal rank of the first relevant result in the first K, or 0 on a miss.
- **Abstention accuracy** measures agreement between an empty ranking and an empty relevance list. A nonempty ranking with no relevant result can get abstention right for an answerable query while still missing every relevant version.

The report averages the first three metrics over answerable cases and
abstention accuracy over all cases. Ranking averages and deltas are `null` when
there are no answerable cases. Deltas subtract baseline from variant. Per-case
scores include trace IDs for inspection.

Inputs are limited to 8 MiB, 1,000 cases, 200 IDs per list, and K between 1 and 200. Case IDs and trace IDs must be unique across the input. UUIDs are
case-insensitive and cannot repeat within a list. Invalid input exits with status
1 and a fixed diagnostic.

The report measures version-anchor ranking. Read-time replay may select different
Observation evidence for an answer. Keep the dataset and run configurations
alongside the report so the comparison can be reproduced.

For write quality, final answers and stale facts in delivered context, see the
[targeted memory evaluation metrics](metrics.md).
