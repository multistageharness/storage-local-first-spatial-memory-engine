/**
 * Integration use case — "agent memory over a foreign repo, the connector
 * way".
 *
 * The sibling of integration/repo.ts: same corpus (mui/material-ui), same
 * ground-truth lookups, but ingested through the FilesystemConnector and
 * the FederatedEngine crawl runner instead of calling MemoryEngine
 * directly. This is the path a real org uses — discover → fullCrawl →
 * checkpoint-after-commit → federated query — exercised end-to-end over a
 * tree someone already checked out onto local disk.
 *
 * It clones the same sparse subtree as repo.ts and reuses that cached
 * clone (no second multi-hundred-MB download), then:
 *   1. full crawl  → every source file lands as a verbatim atom on one
 *      shard, top-level dirs become routing clusters;
 *   2. federated lookups with ground truth — each query's path fragment
 *      must appear in a top-10 hit or the script exits non-zero;
 *   3. a second 'auto' crawl with NO edits → delta mode, zero docs
 *      re-ingested, and the connector's rsync quickcheck hashes ZERO
 *      files (mtime+size all match the manifest cursor) — the property
 *      that makes a filesystem refresh cost a stat() per file, not a read.
 *
 * Requires network on first run; the clone is cached and reused after.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FederatedEngine } from '../dist/src/federated-engine.js';
import { FilesystemConnector } from '../dist/src/connectors/filesystem.js';
import { runCrawl } from '../dist/src/connectors/runner.js';
import type { ShardDescriptor } from '../dist/src/connectors/types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // integration/ → project root (run as source via tsx)
const REPO_URL = 'https://github.com/mui/material-ui.git';
const REPO_DIR = join(ROOT, 'integration', 'repo'); // shared with integration/repo.ts
const CLONE_DIR = join(REPO_DIR, 'material-ui');
const SPARSE_PATH = 'packages/mui-material/src'; // only this subtree is materialized
const ENGINE_ROOT = join(ROOT, '.data', 'integration-codebase-fs');
const MAX_FILE_BYTES = 256 * 1024; // skip generated monsters
const SHARD_KEY = 'fs:material-ui';

function git(args: string[], cwd?: string): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
}

/** Idempotent download: reuse a cached clone, else sparse+shallow clone (full shallow as fallback). */
function ensureRepo(): void {
  if (existsSync(join(CLONE_DIR, '.git'))) {
    console.log(`[repo] reusing cached clone at ${relative(ROOT, CLONE_DIR)}`);
    return;
  }
  mkdirSync(REPO_DIR, { recursive: true });
  console.log(`[repo] cloning ${REPO_URL} (sparse: ${SPARSE_PATH}) …`);
  try {
    git(['clone', '--depth', '1', '--filter=blob:none', '--sparse', REPO_URL, CLONE_DIR]);
    git(['sparse-checkout', 'set', SPARSE_PATH], CLONE_DIR);
  } catch {
    console.log('[repo] sparse clone unsupported — falling back to full shallow clone');
    rmSync(CLONE_DIR, { recursive: true, force: true });
    git(['clone', '--depth', '1', REPO_URL, CLONE_DIR]);
  }
}

async function main(): Promise<void> {
  console.log('\n=== integration: RAG over a foreign repo via FilesystemConnector (mui/material-ui) ===\n');
  ensureRepo();
  rmSync(ENGINE_ROOT, { recursive: true, force: true });
  mkdirSync(ENGINE_ROOT, { recursive: true });

  const org = await FederatedEngine.open({ rootDir: ENGINE_ROOT });
  const connector = new FilesystemConnector({
    roots: [{ name: 'material-ui', path: join(CLONE_DIR, SPARSE_PATH), displayName: 'mui/material-ui' }],
    include: /\.(ts|tsx|js|jsx)$/,
    // default exclude minus vendor/dist plus test/spec/.d.ts (foreign source, not fixtures)
    exclude: /(^|\/)(node_modules|\.git|dist|build)(\/|$)|\.(test|spec)\.|\.d\.ts$/,
    maxBytesPerFile: MAX_FILE_BYTES,
  });

  // -- full crawl through the runner (checkpoint-after-commit) ----------------
  let shard: ShardDescriptor | undefined;
  for await (const d of connector.discoverShards()) shard = d;
  if (!shard) throw new Error('connector discovered no shards');
  console.log(`[crawl] discovered ${shard.shardKey} — ${shard.clusters?.length ?? 0} top-level clusters`);

  const full = await runCrawl(org, connector, shard, { mode: 'full' });
  console.log(
    `[crawl] full: ${full.docs} files → ${full.atoms} verbatim atoms in ${full.ms} ms ` +
      `(${connector.filesHashed} hashed)`,
  );

  // -- agent-style identifier lookups with ground truth ----------------------
  // expect = path fragment that must appear in a top-10 hit's originFile
  const lookups: { query: string; expect: string; note: string }[] = [
    { query: 'useMediaQuery', expect: 'useMediaQuery', note: 'exported hook' },
    { query: 'createTheme', expect: 'createTheme', note: 'theme factory' },
    { query: 'ButtonBase', expect: 'ButtonBase', note: 'foundational component' },
    { query: 'TouchRipple', expect: 'TouchRipple', note: 'internal sub-component' },
    { query: 'CircularProgress', expect: 'CircularProgress', note: 'camelCase identifier' },
    { query: 'Autocomplete', expect: 'Autocomplete', note: 'SUBSTRING of useAutocomplete too' },
  ];

  let failures = 0;
  for (const { query, expect, note } of lookups) {
    const { hits } = await org.search(query, { shard: SHARD_KEY, strict: true, limit: 10 });
    const found = hits.some((h) => (h.originFile ?? '').includes(expect));
    const status = found ? 'ok ' : 'MISS';
    console.log(`[query] ${status} "${query}" (${note}) → top: ${hits[0]?.originFile ?? '∅'} [${hits[0]?.cluster ?? '-'}]`);
    if (!found) failures++;
  }

  // -- assemble a RAG context block ------------------------------------------
  const question = 'How does Material UI decide a palette contrast text color?';
  const { hits: ctx } = await org.search('contrastText getContrastRatio', { shard: SHARD_KEY, strict: true, limit: 3 });
  console.log(`\n[rag] question: "${question}"`);
  console.log(`[rag] context (${ctx.length} verbatim atoms):`);
  for (const h of ctx) {
    console.log(`  ── ${h.originFile} #${h.chunkIndex} [${h.cluster}, rrf ${h.rrfScore.toFixed(4)}]`);
  }

  // -- second crawl, no edits → delta + rsync quickcheck verification --------
  connector.filesHashed = 0;
  connector.filesWalked = 0;
  const delta = await runCrawl(org, connector, shard, { mode: 'auto' });
  console.log(
    `\n[crawl] delta (no edits): mode=${delta.mode} docs=${delta.docs} ` +
      `walked=${connector.filesWalked} hashed=${connector.filesHashed}`,
  );
  if (delta.mode !== 'delta') { console.error('FAIL: second crawl was not delta mode'); failures++; }
  if (delta.docs !== 0) { console.error(`FAIL: delta re-ingested ${delta.docs} unchanged files`); failures++; }
  if (connector.filesHashed !== 0) {
    console.error(`FAIL: quickcheck hashed ${connector.filesHashed} unchanged files (expected 0)`);
    failures++;
  }

  const stats = await org.stats();
  console.log(`\n[stats] shards=${stats.shards} atoms=${stats.totalAtoms} docs=${stats.totalDocs}`);

  await org.close();
  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log(
    `\nPASS: ${lookups.length}/${lookups.length} ground-truth lookups hit, delta no-op clean, ` +
      `rsync quickcheck hashed 0 unchanged files — FilesystemConnector RAG verified.\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
