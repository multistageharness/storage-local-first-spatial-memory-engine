/**
 * RAG at scale — end-to-end demonstration of the spatial memory engine
 * as the retrieval layer of a Retrieval-Augmented Generation pipeline.
 *
 *   1. Generate a deterministic synthetic code corpus (N documents,
 *      ~2–5 KB each) across six topical domains, with unique "needle"
 *      identifiers planted for ground-truth evaluation.
 *   2. Ingest: chunk → keyword-density cluster routing → verbatim atoms,
 *      all through the singleton writer (BEGIN IMMEDIATE batches).
 *   3. Query storm: M concurrent FTS5 trigram BM25 searches — camelCase
 *      substring needle lookups with recall@10 scored against ground
 *      truth, plus domain keyword queries.
 *   4. Assemble an actual RAG context block from top-k hits.
 *   5. Drain the CRDT event-sourced outbox via the background sync worker.
 *
 * Usage: node dist/examples/rag-at-scale.js [--docs 1000] [--queries 100] [--db path]
 * Exits non-zero if recall@10 < 0.95 — this is a verifiable gate, not a demo.
 */
import { mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MemoryEngine } from '../dist/src/engine.js';

// ---- CLI ----------------------------------------------------------------

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DOCS = Number(arg('docs', '1000'));
const QUERIES = Number(arg('queries', '100'));
const DB_PATH = arg('db', join(process.cwd(), '.data', 'rag-demo.db'));
const RECALL_GATE = 0.95;

// ---- deterministic corpus generator --------------------------------------

/** mulberry32 — seeded PRNG so every run generates the identical corpus. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DOMAINS = [
  {
    name: 'auth',
    keywords: ['login', 'password', 'token', 'session', 'oauth', 'credential'],
    nouns: ['Session', 'Token', 'Credential', 'Login', 'Password', 'Identity'],
    verbs: ['validate', 'issue', 'revoke', 'refresh', 'hash', 'authorize'],
  },
  {
    name: 'billing',
    keywords: ['invoice', 'payment', 'stripe', 'charge', 'subscription', 'refund'],
    nouns: ['Invoice', 'Payment', 'Charge', 'Subscription', 'Refund', 'Receipt'],
    verbs: ['calculate', 'process', 'capture', 'settle', 'prorate', 'reconcile'],
  },
  {
    name: 'storage',
    keywords: ['bucket', 'blob', 'upload', 'download', 'multipart', 'checksum'],
    nouns: ['Bucket', 'Blob', 'Upload', 'Manifest', 'Checksum', 'Object'],
    verbs: ['stream', 'persist', 'replicate', 'verify', 'compact', 'restore'],
  },
  {
    name: 'networking',
    keywords: ['socket', 'request', 'response', 'retry', 'timeout', 'header'],
    nouns: ['Socket', 'Request', 'Response', 'Header', 'Backoff', 'Route'],
    verbs: ['dispatch', 'negotiate', 'multiplex', 'throttle', 'resolve', 'proxy'],
  },
  {
    name: 'search',
    keywords: ['index', 'query', 'ranking', 'tokenizer', 'snippet', 'relevance'],
    nouns: ['Index', 'Query', 'Ranking', 'Tokenizer', 'Snippet', 'Posting'],
    verbs: ['tokenize', 'rank', 'merge', 'highlight', 'score', 'rewrite'],
  },
  {
    name: 'ui',
    keywords: ['component', 'render', 'props', 'layout', 'theme', 'widget'],
    nouns: ['Component', 'Layout', 'Theme', 'Widget', 'Panel', 'Toolbar'],
    verbs: ['render', 'hydrate', 'memoize', 'animate', 'compose', 'mount'],
  },
];

interface Doc {
  title: string;
  text: string;
  originFile: string;
  domain: string;
  /** unique planted identifier, e.g. calculateTotalPrice0421 */
  needle: string;
  /** the partial camelCase query used to find it, e.g. TotalPrice0421 */
  needleQuery: string;
}

function pick<T>(rnd: () => number, xs: T[]): T {
  return xs[Math.floor(rnd() * xs.length)];
}

function generateDoc(rnd: () => number, i: number): Doc {
  const domain = DOMAINS[i % DOMAINS.length];
  const id = String(i).padStart(4, '0');
  const noun = pick(rnd, domain.nouns);
  const verb = pick(rnd, domain.verbs);
  // planted ground-truth identifier; query later by camelCase SUFFIX only
  const needle = `${verb}Total${noun}${id}`;
  const needleQuery = `Total${noun}${id}`;

  const fns: string[] = [];
  const fnCount = 3 + Math.floor(rnd() * 5);
  for (let f = 0; f < fnCount; f++) {
    const v = pick(rnd, domain.verbs);
    const n = pick(rnd, domain.nouns);
    const kw1 = pick(rnd, domain.keywords);
    const kw2 = pick(rnd, domain.keywords);
    fns.push(
      [
        `/** ${v}s the ${kw1} for the active ${kw2} pipeline. */`,
        `export async function ${v}${n}${f}(input: ${n}Input): Promise<${n}Result> {`,
        `  const ${kw1}State = await load${n}State(input.${kw2}Id);`,
        `  if (!${kw1}State.valid) throw new ${n}Error('invalid ${kw1} state');`,
        `  const result = ${v}Core(${kw1}State, input.options ?? default${n}Options);`,
        `  await persist${n}(result, { ${kw2}: true });`,
        `  return result;`,
        `}`,
      ].join('\n'),
    );
  }
  // the needle function, planted mid-document
  const needleFn = [
    `/** Ground-truth needle for retrieval evaluation. */`,
    `export function ${needle}(items: LineItem[]): number {`,
    `  return items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0);`,
    `}`,
  ].join('\n');
  fns.splice(Math.floor(fns.length / 2), 0, needleFn);

  return {
    title: `${domain.name}/${verb}${noun}${id}.ts`,
    text: fns.join('\n\n'),
    originFile: `src/${domain.name}/${verb}${noun}${id}.ts`,
    domain: domain.name,
    needle,
    needleQuery,
  };
}

// ---- metrics --------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 1 });

// ---- main -----------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n=== RAG at scale — ${DOCS} docs, ${QUERIES} queries ===\n`);
  mkdirSync(dirname(DB_PATH), { recursive: true });
  if (existsSync(DB_PATH)) rmSync(DB_PATH);
  for (const suffix of ['-wal', '-shm']) if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);

  const engine = await MemoryEngine.open({
    dbPath: DB_PATH,
    graph: 'rag-demo',
    clusters: DOMAINS.map((d) => ({ name: d.name, keywords: d.keywords })),
    minReaders: 2,
    syncIntervalMs: 0, // manual sync rounds below
  });

  // -- 1+2. generate + ingest ----------------------------------------------
  const rnd = mulberry32(0xc0ffee);
  const docs = Array.from({ length: DOCS }, (_, i) => generateDoc(rnd, i));

  console.log(`[ingest] ${DOCS} documents (chunk → route → verbatim atoms)…`);
  const t0 = performance.now();
  let atomCount = 0;
  const routed: Record<string, number> = {};
  const INGEST_CONCURRENCY = 32;
  for (let i = 0; i < docs.length; i += INGEST_CONCURRENCY) {
    const batch = docs.slice(i, i + INGEST_CONCURRENCY);
    const results = await Promise.all(
      batch.map((d) => engine.ingestDocument({ title: d.title, text: d.text, originFile: d.originFile })),
    );
    for (const r of results) {
      atomCount += r.chunks;
      for (const [c, n] of Object.entries(r.clusters)) routed[c] = (routed[c] ?? 0) + n;
    }
  }
  const ingestMs = performance.now() - t0;
  console.log(
    `[ingest] ${fmt(atomCount)} atoms in ${fmt(ingestMs)} ms ` +
      `(${fmt(DOCS / (ingestMs / 1000))} docs/s, ${fmt(atomCount / (ingestMs / 1000))} atoms/s)`,
  );
  console.log(`[ingest] cluster routing: ${JSON.stringify(routed)}`);

  const statsAfterIngest = await engine.stats();
  if (statsAfterIngest.nodes !== statsAfterIngest.ftsRows) {
    throw new Error(`FTS index drift: nodes=${statsAfterIngest.nodes} ftsRows=${statsAfterIngest.ftsRows}`);
  }
  console.log(`[ingest] FTS5 index in lock-step: ${fmt(statsAfterIngest.nodes as number)} rows ✓\n`);

  // -- 3. concurrent query storm --------------------------------------------
  console.log(`[query] storm: ${QUERIES} concurrent searches (needle recall@10 + domain keywords)…`);
  const qrnd = mulberry32(0xbeef);
  const needleTargets = Array.from({ length: QUERIES }, () => docs[Math.floor(qrnd() * docs.length)]);

  const latencies: number[] = [];
  let recallHits = 0;
  const tq = performance.now();
  await Promise.all(
    needleTargets.map(async (doc) => {
      const qs = performance.now();
      // camelCase SUFFIX query — trigram finds "TotalPrice…" inside
      // "calculateTotalPrice…" with zero embedding fuzz
      const hits = await engine.search(doc.needleQuery, { limit: 10 });
      latencies.push(performance.now() - qs);
      if (hits.some((h) => h.originFile === doc.originFile)) recallHits++;
    }),
  );
  const stormMs = performance.now() - tq;
  latencies.sort((a, b) => a - b);
  const recall = recallHits / needleTargets.length;
  console.log(
    `[query] ${QUERIES} queries in ${fmt(stormMs)} ms — ` +
      `${fmt(QUERIES / (stormMs / 1000))} q/s | ` +
      `p50 ${fmt(percentile(latencies, 50))} ms, p95 ${fmt(percentile(latencies, 95))} ms, p99 ${fmt(percentile(latencies, 99))} ms`,
  );
  console.log(`[query] recall@10 (exact-match needles): ${(recall * 100).toFixed(1)}% (${recallHits}/${needleTargets.length})`);
  console.log(`[query] reader pool scaled to ${engine.readerCount} read threads\n`);

  // -- 4. RAG context assembly ----------------------------------------------
  const sample = needleTargets[0];
  const ragHits = await engine.search(sample.needleQuery, { limit: 3 });
  console.log(`[rag] question: "How is ${sample.needle} implemented?"`);
  console.log(`[rag] assembled context (top-${ragHits.length} verbatim atoms):\n`);
  for (const h of ragHits) {
    console.log(`  ── ${h.originFile} #${h.chunkIndex} [cluster: ${h.cluster}, bm25: ${h.score.toFixed(2)}]`);
    for (const line of h.body.split('\n').slice(0, 4)) console.log(`  │ ${line}`);
    console.log('  │ …\n');
  }

  // -- 5. drain the CRDT outbox ----------------------------------------------
  console.log(`[sync] draining event-sourced outbox via background sync worker…`);
  const ts = performance.now();
  let rounds = 0;
  let totalMerged = 0;
  for (;;) {
    const { merged } = await engine.syncNow();
    rounds++;
    totalMerged += merged;
    const s = await engine.stats();
    if ((s.outboxDirty as number) === 0) break;
    if (rounds > 1000) throw new Error('outbox failed to drain');
  }
  const syncMs = performance.now() - ts;
  const finalStats = await engine.stats();
  console.log(
    `[sync] ${fmt(totalMerged)} node merges in ${rounds} rounds, ${fmt(syncMs)} ms — ` +
      `outboxDirty=${finalStats.outboxDirty}, all nodes ${JSON.stringify(finalStats.nodesByStatus)}`,
  );

  const dbBytes = statSync(DB_PATH).size;
  console.log(`\n[db] ${DB_PATH} — ${fmt(dbBytes / 1024 / 1024)} MB, journal_mode=${finalStats.journalMode}`);

  await engine.close();

  // -- verdict ---------------------------------------------------------------
  if (recall < RECALL_GATE) {
    console.error(`\nFAIL: recall@10 ${(recall * 100).toFixed(1)}% < gate ${RECALL_GATE * 100}%`);
    process.exit(1);
  }
  console.log(`\nPASS: recall@10 ${(recall * 100).toFixed(1)}% ≥ ${RECALL_GATE * 100}% — RAG retrieval verified at scale.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
