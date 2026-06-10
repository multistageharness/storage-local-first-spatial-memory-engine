# integration/Makefile — build/run a single integration gate from this dir.
#
# Why this exists: running `tsc integration/foo.ts` names a file on the
# command line, which makes tsc IGNORE tsconfig.json and emit
#   TS5112: 'tsconfig.json' is present but will not be loaded because
#           'files' are specified on the command line.
# The fix is to compile in PROJECT mode (tsc -p, honoring ../tsconfig.json)
# and then run the emitted JS out of ../dist/integration/. We never pass a
# .ts path to tsc, so TS5112 can't happen.
#
#   make build                 type-check + emit the whole project (tsc -p)
#   make run  FILE=codebase-fs run one gate (builds first), pass args via ARGS
#   make FILE=codebase-fs      shorthand for `make run FILE=...`
#   make list                  list runnable .ts gates in this dir
#   make clean                 remove ../dist
#
# Examples:
#   make run FILE=codebase-fs
#   make run FILE=rag-at-org-scale ARGS="--shards 500 --recall-only"

ROOT    := $(abspath $(CURDIR)/..)
TSCONFIG := $(ROOT)/tsconfig.json
DIST    := $(ROOT)/dist/integration
TSC     := $(ROOT)/node_modules/.bin/tsc

# default gate; override on the command line: make run FILE=org-ingest
FILE ?= codebase-fs
ARGS ?=

.PHONY: run build list clean

# default target: build + run FILE
run: build
	node $(DIST)/$(FILE).js $(ARGS)

# project-mode compile — honors ../tsconfig.json, no TS5112
build:
	$(TSC) -p $(TSCONFIG)

list:
	@ls $(CURDIR)/*.ts | sed 's#.*/##; s/\.ts$$//'

clean:
	rm -rf $(ROOT)/dist
