/**
 * Integration example — "the FilesystemConnector filter contract".
 *
 * A focused, self-contained demonstration of the three filter knobs the
 * FilesystemConnector exposes (src/connectors/filesystem.ts):
 *
 *   - include          : RegExp — a file is KEPT only if its root-relative,
 *                        forward-slash path matches  (default: a fixed set of
 *                        source/text extensions);
 *   - exclude          : RegExp — a file is DROPPED if its path matches; drop
 *                        wins over keep  (default: node_modules|.git|dist|
 *                        build|vendor at any depth);
 *   - maxBytesPerFile  : number — files larger than this (or empty) are
 *                        skipped  (default: 131072 = 128 KiB).
 *
 * Both regexes are tested against the WHOLE root-relative path, not the
 * basename — so they match on directories (`(^|/)__tests__/`) and on
 * extensions (`\.test\.ts$`) alike. They are all-or-nothing REPLACEMENTS,
 * not additive: pass a custom `exclude` and you lose the built-in
 * node_modules/.git/… defaults unless you re-include them.
 *
 * Unlike the other fs gate (integration/codebase-fs.ts) this needs NO network
 * and clones nothing: it materializes a tiny synthetic tree on local disk,
 * then runs four crawls that change ONE knob at a time and asserts which
 * files the filter admits.
 *
 *   S1 defaults              → 9 files  (broad include, default exclude/size)
 *   S2 include = /\.ts$/     → 4 files  (narrow the file types)
 *   S3 + exclude tests       → 2 files  (drop *.test.ts and __tests__/)
 *   S4 + raise maxBytes      → 3 files  (admit a >128 KiB generated file)
 *
 * Each scenario is checked two ways that must agree: the exact admitted set
 * (read straight off the connector's fullCrawl stream, where every batched
 * SourceDocument's `sourceKey` IS its root-relative path) AND the doc count
 * reported by the real connector→runner→FederatedEngine ingest path.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FederatedEngine } from '../dist/src/federated-engine.js';
import { FilesystemConnector } from '../dist/src/connectors/filesystem.js';
import type { FilesystemConnectorOptions } from '../dist/src/connectors/filesystem.js';
import { runCrawl } from '../dist/src/connectors/runner.js';
import type { ShardDescriptor } from '../dist/src/connectors/types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // integration/ → project root (run as source via tsx)
const BASE = join(ROOT, '.data', 'integration-fs-filters');
const TREE = join(BASE, 'tree'); // the synthetic corpus we crawl
const ROOT_NAME = 'demo';
const SHARD_KEY = `fs:${ROOT_NAME}`;

/** The synthetic corpus. Each entry: a root-relative path and how big to make
 *  it. 'big' is intentionally over the 128 KiB default cap; everything else is
 *  a few bytes. The extensions + directories are chosen so each filter knob
 *  has something to act on. */
const TREE_FILES: { path: string; big?: boolean }[] = [
  { path: 'src/app.ts' }, //            kept by every scenario
  { path: 'src/lib/util.ts' }, //       kept by every scenario
  { path: 'src/lib/helper.js' }, //     .js — out once include narrows to .ts
  { path: 'docs/guide.md' }, //         .md — in by default, out under /\.ts$/
  { path: 'README.md' }, //             .md
  { path: 'config.json' }, //           .json — default include covers it
  { path: 'notes.txt' }, //             .txt — default include covers it
  { path: 'src/app.test.ts' }, //       .ts but a unit test → dropped by S3/S4
  { path: 'src/__tests__/e2e.ts' }, //  .ts but under __tests__/ → dropped by S3/S4
  { path: 'assets/logo.png' }, //       .png — never matches the include set
  { path: 'generated/big.ts', big: true }, // .ts but >128 KiB → in only when cap raised (S4)
  { path: 'node_modules/dep/index.js' }, //   default exclude (node_modules/)
  { path: 'dist/app.js' }, //                 default exclude (dist/)
  { path: 'vendor/lib.js' }, //               default exclude (vendor/)
];

/** Lay the corpus down on disk (idempotent: wiped + rebuilt each run). */
function materializeTree(): void {
  rmSync(TREE, { recursive: true, force: true });
  for (const f of TREE_FILES) {
    const abs = join(TREE, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    // ~200 KiB for the "generated" file (over the 131072 default), tiny otherwise.
    const body = f.big ? `// generated ${f.path}\n` + 'export const BLOB = "' + 'x'.repeat(200_000) + '";\n' : `// file: ${f.path}\nexport const marker = ${JSON.stringify(f.path)};\n`;
    writeFileSync(abs, body);
  }
  console.log(`[tree] materialized ${TREE_FILES.length} files under ${join('.data', 'integration-fs-filters', 'tree')}`);
}

function connectorFor(filters: Partial<FilesystemConnectorOptions>): FilesystemConnector {
  return new FilesystemConnector({
    roots: [{ name: ROOT_NAME, path: TREE, displayName: 'filter-demo' }],
    ...filters,
  });
}

async function firstShard(connector: FilesystemConnector): Promise<ShardDescriptor> {
  let shard: ShardDescriptor | undefined;
  for await (const d of connector.discoverShards()) shard = d;
  if (!shard) throw new Error('connector discovered no shards');
  return shard;
}

/** The exact set of files the filter admits, read off the fullCrawl stream
 *  (every batched SourceDocument's `sourceKey` is its root-relative path).
 *  Deterministic — depends only on the filter, never on retrieval. */
async function admittedFiles(connector: FilesystemConnector, shard: ShardDescriptor): Promise<string[]> {
  const keys: string[] = [];
  for await (const ev of connector.fullCrawl(shard)) {
    for (const doc of ev.batch ?? []) keys.push(doc.sourceKey);
  }
  return keys.sort();
}

/** Run the SAME filter through the real connector→runner→engine path into a
 *  throwaway engine root, and return how many docs the runner committed. */
async function docsThroughRunner(connector: FilesystemConnector, shard: ShardDescriptor, engineRoot: string): Promise<number> {
  rmSync(engineRoot, { recursive: true, force: true });
  mkdirSync(engineRoot, { recursive: true });
  const org = await FederatedEngine.open({ rootDir: engineRoot });
  try {
    const report = await runCrawl(org, connector, shard, { mode: 'full' });
    return report.docs;
  } finally {
    await org.close();
  }
}

interface Scenario {
  label: string;
  filters: Partial<FilesystemConnectorOptions>;
  expect: string[]; // exact admitted set, sorted
}

const SCENARIOS: Scenario[] = [
  {
    label: 'S1 defaults (broad include, default exclude + 128 KiB cap)',
    filters: {},
    expect: ['README.md', 'config.json', 'docs/guide.md', 'notes.txt', 'src/__tests__/e2e.ts', 'src/app.test.ts', 'src/app.ts', 'src/lib/helper.js', 'src/lib/util.ts'],
  },
  {
    label: 'S2 include = /\\.ts$/ (narrow to TypeScript only)',
    filters: { include: /\.ts$/ },
    expect: ['src/__tests__/e2e.ts', 'src/app.test.ts', 'src/app.ts', 'src/lib/util.ts'],
  },
  {
    label: 'S3 + exclude drops *.test.ts and __tests__/',
    filters: {
      include: /\.ts$/,
      exclude: /(^|\/)(node_modules|\.git|dist|build|vendor|__tests__)(\/|$)|\.test\.ts$/,
    },
    expect: ['src/app.ts', 'src/lib/util.ts'],
  },
  {
    label: 'S4 + raise maxBytesPerFile to 1 MB (admit generated/big.ts)',
    filters: {
      include: /\.ts$/,
      exclude: /(^|\/)(node_modules|\.git|dist|build|vendor|__tests__)(\/|$)|\.test\.ts$/,
      maxBytesPerFile: 1_000_000,
    },
    expect: ['generated/big.ts', 'src/app.ts', 'src/lib/util.ts'],
  },
];

async function main(): Promise<void> {
  console.log('\n=== integration: FilesystemConnector filter contract (include / exclude / maxBytesPerFile) ===\n');
  mkdirSync(BASE, { recursive: true });
  materializeTree();

  let failures = 0;
  for (const [i, sc] of SCENARIOS.entries()) {
    const connector = connectorFor(sc.filters);
    const shard = await firstShard(connector);

    const admitted = await admittedFiles(connector, shard);
    const docs = await docsThroughRunner(connectorFor(sc.filters), shard, join(BASE, `engine-s${i + 1}`));

    const setOk = JSON.stringify(admitted) === JSON.stringify(sc.expect);
    const countOk = docs === sc.expect.length;
    const ok = setOk && countOk;
    if (!ok) failures++;

    console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${sc.label}`);
    console.log(`        admitted ${admitted.length}/${TREE_FILES.length}: ${admitted.join(', ') || '∅'}`);
    console.log(`        runner docs=${docs} (expected ${sc.expect.length})`);
    if (!setOk) console.log(`        !! expected set: ${sc.expect.join(', ')}`);
    if (!countOk) console.log('        !! runner doc count disagrees with admitted set');
  }

  console.log('\n--- what changed between scenarios -------------------------------');
  console.log('  S1→S2  include narrowed .md/.json/.txt/.js out (9 → 4) — file-type filter');
  console.log('  S2→S3  exclude dropped *.test.ts and __tests__/ (4 → 2) — path/dir filter');
  console.log('  S3→S4  maxBytesPerFile admitted a >128 KiB generated file (2 → 3) — size filter');

  if (failures > 0) {
    console.error(`\nFAIL: ${failures}/${SCENARIOS.length} scenario(s) did not match — filter contract drifted`);
    process.exit(1);
  }
  console.log(`\nPASS: ${SCENARIOS.length}/${SCENARIOS.length} filter scenarios verified — include/exclude/maxBytesPerFile behave as documented.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
