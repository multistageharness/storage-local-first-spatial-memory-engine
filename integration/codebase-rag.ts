/**
 * Integration use case 1 — "agent memory over a real codebase".
 *
 * Ingests this repository's own src/**\/*.ts files (real code, not a
 * synthetic corpus), routes chunks into topical clusters by keyword
 * density, then answers real identifier lookups an autonomous coding
 * agent would issue — including camelCase-substring queries — and
 * assembles a RAG context block from the top hits.
 *
 * Self-verifying: each query has a ground-truth origin file that must
 * appear in the top-10 hits, or the script exits non-zero.
 */
import { readdirSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryEngine } from '../dist/src/engine.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // integration/ → project root (run as source via tsx)
const SRC = join(ROOT, 'src');
const DB_PATH = join(ROOT, '.data', 'integration-codebase.db');

function freshDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) rmSync(f);
}

async function main(): Promise<void> {
  console.log('\n=== integration: RAG over this repo’s own source ===\n');
  freshDb(DB_PATH);

  const engine = await MemoryEngine.open({
    dbPath: DB_PATH,
    graph: 'codebase',
    clusters: [
      { name: 'database', keywords: ['sqlite', 'pragma', 'transaction', 'journal_mode', 'busy_timeout', 'wal'] },
      { name: 'workers', keywords: ['worker', 'broker', 'thread', 'postMessage', 'parentPort', 'inflight'] },
      { name: 'search', keywords: ['fts5', 'bm25', 'tokenizer', 'trigram', 'snippet', 'match'] },
      { name: 'sync', keywords: ['crdt', 'yjs', 'merge', 'outbox', 'dirty', 'replica'] },
    ],
  });

  // -- ingest every TypeScript source file verbatim -------------------------
  const files = readdirSync(SRC, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => relative(ROOT, join(e.parentPath, e.name)));

  let atoms = 0;
  for (const file of files) {
    const res = await engine.ingestDocument({
      title: file,
      text: readFileSync(join(ROOT, file), 'utf8'),
      originFile: file,
    });
    atoms += res.chunks;
  }
  console.log(`[ingest] ${files.length} source files → ${atoms} verbatim atoms`);

  // -- agent-style identifier lookups with ground truth ---------------------
  const lookups: { query: string; expect: string; note: string }[] = [
    { query: 'busyTimeoutMs', expect: 'src/db/connection.ts', note: 'exact identifier' },
    { query: 'maybeScaleUp', expect: 'src/workers/broker.ts', note: 'private method name' },
    { query: 'sanitizeFtsQuery', expect: 'src/search/query.ts', note: 'exported function' },
    { query: 'mergeBlobs', expect: 'src/sync/crdt.ts', note: 'CRDT merge helper' },
    { query: 'ScaleUp', expect: 'src/workers/broker.ts', note: 'camelCase SUBSTRING of maybeScaleUp' },
    { query: 'IMMEDIATE transaction', expect: 'src/db/connection.ts', note: 'multi-term prose query' },
  ];

  let failures = 0;
  for (const { query, expect, note } of lookups) {
    const hits = await engine.search(query, { limit: 10 });
    const found = hits.some((h) => h.originFile === expect);
    const status = found ? 'ok ' : 'MISS';
    console.log(`[query] ${status} "${query}" (${note}) → top: ${hits[0]?.originFile ?? '∅'} [${hits[0]?.cluster ?? '-'}]`);
    if (!found) failures++;
  }

  // -- assemble a RAG context block ------------------------------------------
  const question = 'How does the engine avoid SQLITE_BUSY deadlocks?';
  const ctx = await engine.search('busy_timeout IMMEDIATE', { limit: 3 });
  console.log(`\n[rag] question: "${question}"`);
  console.log(`[rag] context (${ctx.length} verbatim atoms):`);
  for (const h of ctx) {
    console.log(`  ── ${h.originFile} #${h.chunkIndex} [${h.cluster}, bm25 ${h.score.toFixed(2)}]`);
  }

  await engine.syncNow();
  const stats = await engine.stats();
  console.log(`\n[stats] nodes=${stats.nodes} ftsRows=${stats.ftsRows} outboxDirty=${stats.outboxDirty}`);

  await engine.close();
  if (failures > 0) {
    console.error(`\nFAIL: ${failures}/${lookups.length} ground-truth lookups missed`);
    process.exit(1);
  }
  console.log(`\nPASS: ${lookups.length}/${lookups.length} ground-truth lookups hit — codebase RAG verified.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
