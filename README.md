# Org-Scale Local-First Spatial Memory Engine — demo002

Scales the proven demo001 kernel (hardened SQLite, FTS5 trigram/BM25, 1-writer/N-reader
worker pool, Yjs CRDT outbox) from one project to an **entire Confluence site or
GitHub/GitLab organization** — by federating many kernels, not growing one file.

> Plan: [`.plans/IDEA.v2.md`](./.plans/IDEA.v2.md) · IR artifact: [`.plans/IDEA.v2.IR.md`](./.plans/IDEA.v2.IR.md)
> · Retrospective: [`.plans/RETROSPECTIVE.demo002.md`](./.plans/RETROSPECTIVE.demo002.md)
> · demo001 kernel record: [`.plans/DEMO001.md`](./.plans/DEMO001.md)

## Architecture (IDEA.v2 §2)

```
            FEDERATION LAYER          catalog.db · ShardRouter · FederatedSearch · IngestScheduler
                  │                   (routing signals, checkpoints, persistent work queue)
   ┌──────────────┼──────────────┐
   │ shard: gh:acme/payments     │    one Graph = one shard = one .db = one demo001 kernel
   │ shard: cf:ENG …             │    (1W/NR pool, dual FTS5, CRDT outbox — lazily opened, LRU-pooled)
   └──────────────┼──────────────┘
            CONNECTOR LAYER           ConfluenceConnector (CQL delta) · GitOrgConnector (commit delta)
                                      checkpoint-after-commit, content-hash dedup, rate-limit survival
```

- **Shard kernel (demo001, kept verbatim)** + v2 deltas: `documents` table with
  `replaceDocument`/`deleteDocument` (content-hash no-op incremental ingest), a second
  unicode61 FTS index, `hybridSearch` (trigram ∪ word ∪ optional vector lane, RRF k=60,
  per-term fusion with identifier-weighted lanes), epoch-based CRDT GC + causal-stability
  tracking, logical schema migrations inside the CRDT blob.
- **Federation**: catalog (shard registry, tf×idf routing signatures with cross-shard IDF,
  durable ingest queue), ShardPool (LRU + worker budget), ShardRouter (hint short-circuit,
  per-term candidate nomination, ε-weighted recency), FederatedSearch (rank-based RRF
  fusion — never BM25 score summation — quorum/straggler policy, probe-wave deepening;
  `strict:true` probes every candidate for recall gates), token-budgeted context assembly.
- **Connectors**: streaming, checkpointed, idempotent. A crash between batch commit and
  checkpoint re-ingests exactly one batch (hash no-op), never loses data.

## Quick start

```sh
npm ci && npm run build
make test            # 181 unit tests (kernel + federation + connectors + eval)
make all             # test + eval + benchmark + perf + scale + integration (offline, seeded)
make scale-big       # 500-shard recall profile (latency reported, not gated)
SOAK_MINUTES=1 make soak   # nightly soak, smoke profile
```

Every target exits non-zero on failure and writes a report under `reports/`.

## Gates (the acceptance matrix, IDEA.v2 §9)

| Gate | Proves |
|---|---|
| `org-ingest` | queue-driven parallel ingest: zero lost writes vs ground truth, dual-FTS lock-step per shard, ≥ 1,500 atoms/s, durable checkpoints |
| `rag-at-org-scale` | the headline: needle recall@10 ≥ 0.98 (no graph hint), cross-shard recall@20 ≥ 0.90, router recall ≥ 0.99, abstention = 1.0, pinned p50 ≤ 80 ms, federated p95 ≤ 500 ms @ 200-way |
| `org-incremental` | ≥ 99% hash-skip, old content unfindable, 1-doc delta ≤ 2 s, idempotent cursor replay |
| `multi-writer-org` | two OS processes, one rootDir, contended shard: zero lost writes, zero SQLITE_BUSY, catalog convergence, graph firewall |
| `federated-replica-sync` | tiered partial replication, anti-LWW byte-identical convergence, stale-epoch → CONFLICT (never corruption), snapshot adoption |
| `confluence-gate` | fixture-site crawl through 429 storms + crash/resume; code macros retrievable byte-verbatim; trashed pages unfindable |
| `repo-org-gate` | 12-repo clone fan-out; deltas ∝ change set (incl. renames); clone cache reused |
| `eval-gate-federated` | federated goldens with router/retriever/generator three-way attribution (`--jury` swaps the judge) |
| `benchmark-org-gate` | org-synthetic-v2 (five bands incl. cross-shard), confluence-fixture-v2, repo-org-v2 (per-shard auto-annotation) |
| `perf-gate` | seeded micro/macro suite vs checked-in baselines, ±25% one-sided bands |
| `soak` | rolling ingest+query+sync+GC loop: RSS plateau, WAL and CRDT blobs bounded, zero errors |

demo001's own gates (`codebase-rag`, `multi-writer-concurrency`, `crdt-replica-sync`,
`eval-gate`, `benchmark-gate`, `rag-at-scale`, `benchmark-react`) all still run and pass —
the kernel keeps every guarantee it shipped with.

## Status vs plan

All IDEA.v2 phases (5–10) implemented and gated. Known deviations and the large-corpus
readiness statement are recorded in the IR as-built addendum
([`.plans/IDEA.v2.IR.md`](./.plans/IDEA.v2.IR.md)) and the retrospective — headline:
retrieval quality holds at 500 shards, but query latency past the LRU ceiling is bounded
by per-shard worker-pool cold-opens (the named bottleneck for v2.1).
