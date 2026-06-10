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
#   make perf-rebaseline  pin a per-runner perf baseline on THIS host (cloud/CI
#                         runners differ from the committed baseline's hardware)
#   make perf-runner-class  print this runner's derived hardware-class key
#   make scale            rag-at-scale (demo001 kernel) + rag-at-org-scale (default profile)
#   make scale-big        rag-at-org-scale --shards 500 --recall-only   (manual / nightly)
#   make integration      demo001 gates + org-ingest, org-incremental, multi-writer-org,
#                         federated-replica-sync, confluence-gate, repo-org-gate
#   make gate FILE=x      build + run ONE integration gate by name (ARGS=... to pass args)
#   make list             list runnable .ts gates under integration/
#   make soak             nightly only (4 h default; SOAK_MINUTES=1 for a smoke pass)
#   make all              test + eval + benchmark + perf + scale + integration
#
# Single-gate examples (`build` compiles the LIBRARY to dist/src; the gate then
# runs as TypeScript source via tsx, importing that compiled library from
# ../dist/src — integration/ is excluded from the tsc build, so its .ts files
# are never emitted to dist/):
#   make gate FILE=codebase-fs
#   make gate FILE=rag-at-org-scale ARGS="--shards 500 --recall-only"

REPORTS      := reports
REACT_REPO   := .repos/react
REACT_URL    := https://github.com/facebook/react
SOAK_MINUTES ?= 240

# Integration gates are run as TypeScript SOURCE via tsx (they import the
# compiled library from ../dist/src, which `build` produces). tsx lives in the
# project's local node_modules/.bin, which is NOT on a bare `make` shell's PATH
# (npm scripts add it automatically; make does not) — so invoke it by its
# relative bin path. Override to a global `tsx`/`npx tsx` if preferred.
TSX ?= node_modules/.bin/tsx

# Every gate depends on $(BUILD), which defaults to the `build` target (tsc +
# verify-workers). To run a gate against the EXISTING dist/ without rebuilding
# — faster iteration when you know dist/ is current — override it to empty:
#   make eval BUILD=
#   make integration BUILD=
# With BUILD= the gate has no build prerequisite and runs straight off dist/.
BUILD ?= build

# Single-gate runner (see header). Override on the command line:
#   make gate FILE=org-ingest ARGS="--report reports/org-ingest-report.json"
FILE ?= codebase-fs
ARGS ?=

.PHONY: all test eval benchmark benchmark-react benchmarks perf perf-rebaseline perf-runner-class scale scale-big integration gate list soak build verify-workers clean

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

test: $(BUILD) | $(REPORTS)
	node --test \
	  --test-reporter=spec --test-reporter-destination=stdout \
	  --test-reporter=tap  --test-reporter-destination=$(REPORTS)/test-report.tap \
	  "dist/__test__/*.test.js"
	@echo "test: report written to $(REPORTS)/test-report.tap"

eval: $(BUILD) | $(REPORTS)
	$(TSX) integration/eval-gate.ts --report $(REPORTS)/eval-report.json
	$(TSX) integration/eval-gate-federated.ts --report $(REPORTS)/eval-federated-report.json

benchmark: $(BUILD) | $(REPORTS)
	$(TSX) integration/benchmark-gate.ts --report $(REPORTS)/benchmark-report.json
	$(TSX) integration/benchmark-org-gate.ts --report $(REPORTS)/benchmark-org-report.json

# clones facebook/react (shallow) on first run, then reuses the checkout
benchmark-react: $(BUILD) | $(REPORTS) $(REACT_REPO)
	$(TSX) integration/benchmark-react-gate.ts \
	  --repo $(REACT_REPO) --report $(REPORTS)/benchmark-react-report.json

$(REACT_REPO):
	mkdir -p $(dir $(REACT_REPO))
	git clone --depth 1 $(REACT_URL) $(REACT_REPO)

benchmarks: benchmark benchmark-react

perf: $(BUILD) | $(REPORTS)
	$(TSX) integration/perf-gate.ts --report $(REPORTS)/perf-report.json

# Re-capture the perf baseline for THIS runner's hardware class. The ±25%
# bands assume the baseline and the gated run share hardware; a cloud/CI
# runner that differs from the machine that produced the checked-in baseline
# trips the gate on hardware grounds alone (perf-gate prints the env diff + a
# hardware-mismatch note when it fails). This writes a class-specific file
# __test__/benchmark/perf-baseline.<class>.json (NOT the committed default),
# which perf auto-selects on matching runners; commit or CI-cache it.
perf-rebaseline: $(BUILD) | $(REPORTS)
	$(TSX) integration/perf-gate.ts --update-baseline --report $(REPORTS)/perf-report.json

# Print the derived hardware-class key for this runner (CI wiring / debugging).
perf-runner-class: $(BUILD)
	@$(TSX) integration/perf-gate.ts --print-runner-class

scale: $(BUILD) | $(REPORTS)
	$(TSX) integration/rag-at-scale.ts
	$(TSX) integration/rag-at-org-scale.ts --report $(REPORTS)/rag-at-org-scale-report.json

# 500-shard recall profile; latency reported, not gated (the per-shard
# worker-pool cold-open cost past the LRU ceiling is the known v2
# bottleneck — see the retrospective). 2,000-shard variant: add
# --shards 2000 --docs-per-shard 400.
scale-big: $(BUILD) | $(REPORTS)
	$(TSX) integration/rag-at-org-scale.ts --shards 500 --queries 1000 --recall-only \
	  --report $(REPORTS)/rag-at-org-scale-big-report.json

integration: $(BUILD) | $(REPORTS)
	$(TSX) integration/codebase-rag.ts
	$(TSX) integration/multi-writer-concurrency.ts
	$(TSX) integration/crdt-replica-sync.ts
	$(TSX) integration/org-ingest.ts --report $(REPORTS)/org-ingest-report.json
	$(TSX) integration/org-incremental.ts --report $(REPORTS)/org-incremental-report.json
	$(TSX) integration/multi-writer-org.ts
	$(TSX) integration/federated-replica-sync.ts
	$(TSX) integration/confluence-gate.ts --report $(REPORTS)/confluence-gate-report.json
	$(TSX) integration/repo-org-gate.ts --report $(REPORTS)/repo-org-gate-report.json

# Build + run ONE integration gate by name (folded in from the old
# integration/Makefile). BUILD= skips the rebuild and runs straight off dist/.
gate: $(BUILD) | $(REPORTS)
	$(TSX) integration/$(FILE).ts $(ARGS)

# List runnable .ts gates under integration/ (strips dir + .ts extension).
list:
	@ls integration/*.ts | sed 's#.*/##; s/\.ts$$//'

soak: $(BUILD) | $(REPORTS)
	$(TSX) integration/soak.ts --minutes $(SOAK_MINUTES) --report $(REPORTS)/soak-report.json

clean:
	rm -rf $(REPORTS) .data dist
