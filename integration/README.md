# Integration use cases

Self-verifying, end-to-end scenarios — each exercises the engine the way a real consumer would and **exits non-zero on any assertion failure**. Run all with `npm run integration`, or individually:

| Script | npm script | Use case | Verifies |
|---|---|---|---|
| [`codebase-rag.ts`](./codebase-rag.ts) | `integration:codebase-rag` | Coding agent memory over a **real codebase** — ingests this repo's own `src/**/*.ts`, answers identifier lookups (`busyTimeoutMs`, camelCase substrings like `ScaleUp`), assembles a RAG context block | trigram exact-match retrieval + keyword-density cluster routing on real code, ground-truth recall on every query |
| [`multi-writer-concurrency.ts`](./multi-writer-concurrency.ts) | `integration:multi-writer` | **Two agents, one DB file** — two engine instances (two writer threads) run interleaved ingest storms against the same SQLite file | WAL + `BEGIN IMMEDIATE` + `busy_timeout` absorb contention (no lost writes, no `SQLITE_BUSY`), FTS stays in lock-step, Graph contextual firewall shows zero cross-graph leaks |
| [`crdt-replica-sync.ts`](./crdt-replica-sync.ts) | `integration:replica-sync` | **Offline-first replicas** (separate DB files) make divergent concurrent edits — A rewrites the body while B renames the title — then exchange CRDT updates | mathematical merge convergence: both replicas end byte-identical, BOTH edits survive (no Last-Write-Wins), outboxes drain to `SYNCED` |
| [`repo.ts`](./repo.ts) | `integration:repo` | Coding agent memory over a **downloaded foreign repo** — sparse/shallow-clones [mui/material-ui](https://github.com/mui/material-ui) (`packages/mui-material/src` only) into `./repo/`, ingests every source file, answers identifier lookups against unfamiliar third-party code | trigram exact-match retrieval at real-repo scale, ground-truth path recall on every query. Needs network on first run (clone is cached in `./repo/`, git-ignored); not part of the default `npm run integration` chain |

## CI gates

The same self-verifying contract powers the deployment gates (each writes a report artifact when run via `make`, and exits non-zero on failure):

| Script | npm script / make target | Gate |
|---|---|---|
| [`rag-at-scale.ts`](./rag-at-scale.ts) | `rag-at-scale[:big]` | retrieval at scale — recall@10 ≥ 95% over a 1k–10k doc synthetic corpus under concurrent query storm |
| [`eval-gate.ts`](./eval-gate.ts) | `eval[:jury]` / `make eval` | synthetic RAG eval — 4 component-isolated metrics (contextual recall/precision, faithfulness, answer relevancy) vs thresholds |
| [`benchmark-gate.ts`](./benchmark-gate.ts) | `benchmark[:jury]` / `make benchmark` | curated golden datasets (engine architecture + React UI ecosystem), distribution-enforced (55/25/10/10) |
| [`benchmark-react-gate.ts`](./benchmark-react-gate.ts) | `benchmark:react` / `make benchmark-react` | massive-repo benchmark — shallow-clones facebook/react, ingests ~1.3k files (~8.6k atoms), auto-annotates 20 cases from the checkout |

These complement `__test__/` — the unit + integration + eval/benchmark test suite (`npm test` / `make test`).
