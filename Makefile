# Org-Scale Local-First Spatial Memory Engine (demo002) — gate entry points.
# (IDEA.v2 §9.3 — every target exits non-zero on failure: standalone CI gates.
#  All defaults offline + seeded; only benchmark-react touches the network.)
#
#   make test             unit suites (kernel + federation + connectors + eval)
#   make eval             eval-gate (demo001) + eval-gate-federated
#   make benchmark        benchmark-gate (demo001 curated) + benchmark-org-gate
#                         (org-synthetic-v2 / confluence-fixture-v2 / repo-org-v2)
#   make benchmark-react  demo001 massive-repo gate, unchanged (clones facebook/react)
#   make perf             perf-gate vs checked-in baselines (±25% bands)
#   make scale            rag-at-scale (demo001 kernel) + rag-at-org-scale (default profile)
#   make scale-big        rag-at-org-scale --shards 500 --recall-only   (manual / nightly)
#   make integration      demo001 gates + org-ingest, org-incremental, multi-writer-org,
#                         federated-replica-sync, confluence-gate, repo-org-gate
#   make soak             nightly only (4 h default; SOAK_MINUTES=1 for a smoke pass)
#   make all              test + eval + benchmark + perf + scale + integration

REPORTS      := reports
REACT_REPO   := .repos/react
REACT_URL    := https://github.com/facebook/react
SOAK_MINUTES ?= 240

.PHONY: all test eval benchmark benchmark-react benchmarks perf scale scale-big integration soak build verify-workers clean

all: test eval benchmark perf scale integration

# Worker entry points are spawned at runtime via new Worker(new URL('./x.js',
# import.meta.url)) and never statically imported (broker.ts:83-84,
# pipeline.ts:10). `npm run build` runs `tsc` in PROJECT mode, which emits
# every file in tsconfig `include` regardless of the import graph — so they
# build. verify-workers guards against a future switch to an entry-point /
# bundle build that would silently drop them. See src/Makefile for detail.
WORKER_ENTRIES := \
  dist/src/workers/writer-worker.js \
  dist/src/workers/reader-worker.js \
  dist/src/sync/sync-worker.js

build: verify-workers

verify-workers:
	npm run build
	@missing=0; for f in $(WORKER_ENTRIES); do \
	  [ -f "$$f" ] || { echo "MISS $$f"; missing=1; }; \
	done; \
	if [ $$missing -ne 0 ]; then \
	  echo "build: a worker entry is missing — build emitted JS by import graph, not \`tsc -p\`"; \
	  exit 1; \
	fi

$(REPORTS):
	mkdir -p $(REPORTS)

test: build | $(REPORTS)
	node --test \
	  --test-reporter=spec --test-reporter-destination=stdout \
	  --test-reporter=tap  --test-reporter-destination=$(REPORTS)/test-report.tap \
	  "dist/__test__/*.test.js"
	@echo "test: report written to $(REPORTS)/test-report.tap"

eval: build | $(REPORTS)
	node dist/integration/eval-gate.js --report $(REPORTS)/eval-report.json
	node dist/integration/eval-gate-federated.js --report $(REPORTS)/eval-federated-report.json

benchmark: build | $(REPORTS)
	node dist/integration/benchmark-gate.js --report $(REPORTS)/benchmark-report.json
	node dist/integration/benchmark-org-gate.js --report $(REPORTS)/benchmark-org-report.json

# clones facebook/react (shallow) on first run, then reuses the checkout
benchmark-react: build | $(REPORTS) $(REACT_REPO)
	node dist/integration/benchmark-react-gate.js \
	  --repo $(REACT_REPO) --report $(REPORTS)/benchmark-react-report.json

$(REACT_REPO):
	mkdir -p $(dir $(REACT_REPO))
	git clone --depth 1 $(REACT_URL) $(REACT_REPO)

benchmarks: benchmark benchmark-react

perf: build | $(REPORTS)
	node dist/integration/perf-gate.js --report $(REPORTS)/perf-report.json

scale: build | $(REPORTS)
	node dist/integration/rag-at-scale.js
	node dist/integration/rag-at-org-scale.js --report $(REPORTS)/rag-at-org-scale-report.json

# 500-shard recall profile; latency reported, not gated (the per-shard
# worker-pool cold-open cost past the LRU ceiling is the known v2
# bottleneck — see the retrospective). 2,000-shard variant: add
# --shards 2000 --docs-per-shard 400.
scale-big: build | $(REPORTS)
	node dist/integration/rag-at-org-scale.js --shards 500 --queries 1000 --recall-only \
	  --report $(REPORTS)/rag-at-org-scale-big-report.json

integration: build | $(REPORTS)
	node dist/integration/codebase-rag.js
	node dist/integration/multi-writer-concurrency.js
	node dist/integration/crdt-replica-sync.js
	node dist/integration/org-ingest.js --report $(REPORTS)/org-ingest-report.json
	node dist/integration/org-incremental.js --report $(REPORTS)/org-incremental-report.json
	node dist/integration/multi-writer-org.js
	node dist/integration/federated-replica-sync.js
	node dist/integration/confluence-gate.js --report $(REPORTS)/confluence-gate-report.json
	node dist/integration/repo-org-gate.js --report $(REPORTS)/repo-org-gate-report.json

soak: build | $(REPORTS)
	node dist/integration/soak.js --minutes $(SOAK_MINUTES) --report $(REPORTS)/soak-report.json

clean:
	rm -rf $(REPORTS) .data dist
