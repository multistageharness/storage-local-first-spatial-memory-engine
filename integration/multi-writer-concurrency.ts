/**
 * Integration use case 2 — "two agents, one database, zero corruption".
 *
 * Exercises the REQ's zero-corruption concurrency claim: two independent
 * MemoryEngine instances (each with its own writer thread, simulating two
 * agent processes) hammer the SAME database file in parallel. WAL +
 * BEGIN IMMEDIATE + busy_timeout must absorb the contention — every
 * write succeeds, no SQLITE_BUSY escapes, and the FTS index stays in
 * lock-step.
 *
 * Also verifies the Graph contextual firewall: each agent's searches see
 * only its own graph, even though both graphs share one file.
 */
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryEngine } from '../src/engine.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PATH = join(ROOT, '.data', 'integration-multiwriter.db');
const DOCS_PER_AGENT = 150;

function freshDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) rmSync(f);
}

const CLUSTERS = [
  { name: 'auth', keywords: ['login', 'token', 'session'] },
  { name: 'billing', keywords: ['invoice', 'payment', 'charge'] },
];

function doc(agent: string, i: number): { title: string; text: string; originFile: string } {
  const domain = i % 2 === 0 ? 'login token session' : 'invoice payment charge';
  return {
    title: `${agent}/module${i}.ts`,
    originFile: `src/${agent}/module${i}.ts`,
    text:
      `// ${domain}\n` +
      `export function commonHandler${agent}${i}(req: Request) {\n` +
      `  const ctx = sharedRuntimeContext.resolve('${domain}');\n` +
      `  return dispatchPipeline(ctx, req); // ${domain}\n` +
      `}\n`.repeat(6),
  };
}

async function main(): Promise<void> {
  console.log('\n=== integration: concurrent writers on one DB file ===\n');
  freshDb(DB_PATH);

  // two engines = two writer threads + two reader pools on one file
  const alpha = await MemoryEngine.open({ dbPath: DB_PATH, graph: 'agent-alpha', clusters: CLUSTERS });
  const beta = await MemoryEngine.open({ dbPath: DB_PATH, graph: 'agent-beta', clusters: CLUSTERS });

  const t0 = performance.now();
  // fire BOTH agents' full ingest storms at once — writes interleave
  const [resA, resB] = await Promise.all([
    Promise.all(Array.from({ length: DOCS_PER_AGENT }, (_, i) => alpha.ingestDocument(doc('Alpha', i)))),
    Promise.all(Array.from({ length: DOCS_PER_AGENT }, (_, i) => beta.ingestDocument(doc('Beta', i)))),
  ]);
  const ms = performance.now() - t0;
  const atomsA = resA.reduce((s, r) => s + r.chunks, 0);
  const atomsB = resB.reduce((s, r) => s + r.chunks, 0);
  console.log(
    `[write] ${DOCS_PER_AGENT}+${DOCS_PER_AGENT} docs (${atomsA}+${atomsB} atoms) interleaved in ${ms.toFixed(0)} ms — zero SQLITE_BUSY escapes`,
  );

  // -- FTS index integrity across both writers -------------------------------
  const stats = await alpha.stats();
  if (stats.nodes !== stats.ftsRows) throw new Error(`FTS drift: nodes=${stats.nodes} fts=${stats.ftsRows}`);
  if ((stats.nodes as number) !== atomsA + atomsB) {
    throw new Error(`lost writes: expected ${atomsA + atomsB} nodes, found ${stats.nodes}`);
  }
  console.log(`[verify] ${stats.nodes} nodes, FTS in lock-step ✓`);

  // -- Graph contextual firewall ---------------------------------------------
  // 'sharedRuntimeContext' appears in EVERY doc of BOTH agents; each
  // engine must only ever see its own graph's atoms.
  const hitsA = await alpha.search('sharedRuntimeContext', { limit: 50 });
  const hitsB = await beta.search('sharedRuntimeContext', { limit: 50 });
  const leakA = hitsA.filter((h) => !h.originFile?.startsWith('src/Alpha/'));
  const leakB = hitsB.filter((h) => !h.originFile?.startsWith('src/Beta/'));
  if (hitsA.length === 0 || hitsB.length === 0) throw new Error('firewall test got no hits');
  if (leakA.length > 0 || leakB.length > 0) {
    throw new Error(`graph firewall breach: alpha leaked ${leakA.length}, beta leaked ${leakB.length}`);
  }
  console.log(`[verify] graph firewall: alpha ${hitsA.length} hits / beta ${hitsB.length} hits, zero cross-graph leaks ✓`);

  // -- both agents drain their outboxes concurrently --------------------------
  for (;;) {
    await Promise.all([alpha.syncNow(), beta.syncNow()]);
    const s = await beta.stats();
    if ((s.outboxDirty as number) === 0) break;
  }
  console.log(`[verify] shared outbox drained by two concurrent sync pipelines ✓`);

  await Promise.all([alpha.close(), beta.close()]);
  console.log('\nPASS: two writers, one file, zero corruption — concurrency hardening verified.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
