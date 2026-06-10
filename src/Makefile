# src/Makefile — build the engine sources from this dir.
#
# Why this exists: three worker entry points are spawned at RUNTIME via
#   new Worker(new URL('./x.js', import.meta.url))
# and are never statically `import`ed:
#   src/workers/writer-worker.ts   (broker.ts:83)
#   src/workers/reader-worker.ts   (broker.ts:84)
#   src/sync/sync-worker.ts        (pipeline.ts:10)
# Any build that compiles by ENTRY POINT (`tsc src/index.ts`, or bundling
# from index) walks only the static import graph and SILENTLY DROPS these
# three -> "not building some files". PROJECT mode (`tsc -p ../tsconfig.json`)
# compiles every file matched by tsconfig `include: ["src/**/*"]` regardless
# of the import graph, so the worker entries are always emitted. Naming a
# .ts file on the command line would also trip TS5112 — so we never do.
#
#   make build    project-mode compile (honors ../tsconfig.json)
#   make verify   build, then assert every dynamic worker entry emitted
#   make clean    remove ../dist

ROOT     := $(abspath $(CURDIR)/..)
TSCONFIG := $(ROOT)/tsconfig.json
TSC      := $(ROOT)/node_modules/.bin/tsc
DIST     := $(ROOT)/dist/src

# entry points loaded via new Worker(URL) — not in the static import graph
WORKER_ENTRIES := \
  $(DIST)/workers/writer-worker.js \
  $(DIST)/workers/reader-worker.js \
  $(DIST)/sync/sync-worker.js

.PHONY: build verify clean

build:
	$(TSC) -p $(TSCONFIG)

# fail loudly if a dynamically-spawned worker entry didn't get emitted
verify: build
	@missing=0; for f in $(WORKER_ENTRIES); do \
	  if [ -f "$$f" ]; then echo "ok   $$f"; \
	  else echo "MISS $$f"; missing=1; fi; \
	done; \
	if [ $$missing -ne 0 ]; then \
	  echo "verify: a worker entry is missing — did something build by entry point instead of \`tsc -p\`?"; \
	  exit 1; \
	fi; \
	echo "verify: all worker entry points emitted"

clean:
	rm -rf $(ROOT)/dist
