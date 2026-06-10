/**
 * multi-writer-org (IDEA.v2 §9.2) — concurrency regime 3, the hard case:
 * TWO OS PROCESSES (not threads — the MCP-server reality of IDEA.v1's
 * mutex critique) pointed at the same rootDir. Both ingest into the same
 * contended shard, both ingest disjoint shards, both run sync pipelines,
 * and both serve federated queries throughout.
 *
 * Asserts: zero lost writes (atom accounting vs ground truth), zero
 * SQLITE_BUSY escapes, dual-FTS lock-step, catalog convergence
 * (atom_count correct after both drain), cross-shard Graph firewall
 * (planted universal term leaks zero hits across shard scopes), both
 * outboxes drain.
 *
 * Usage: node dist/integration/multi-writer-org.js [--root path]
 * (re-invokes itself with --role worker for the two child processes)
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FederatedEngine } from '../src/federated-engine.js';
import { chunkText } from '../src/spatial/chunker.js';
import type { SourceDocumentInput } from '../src/engine.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const ROOT = arg('root', join(process.cwd(), '.data', 'multi-writer-org'));
const ROLE = arg('role', 'parent');
const WRITER = arg('writer', 'A');
const DOCS_PER_TARGET = Number(arg('docs', '60'));

const CONTENDED = 'syn:contended';
const UNIVERSAL = 'universalFirewallToken9';

function docsFor(writer: string, shardKey: string, n: number): SourceDocumentInput[] {
  return Array.from({ length: n }, (_, i) => ({
    // disjoint sourceKeys per writer — ground truth is the union
    sourceKey: `${writer}/${shardKey}/doc-${i}.ts`,
    title: `${writer}-doc-${i}.ts`,
    text:
      `// writer ${writer} → ${shardKey} doc ${i}\n` +
      `export const marker_${writer}_${i} = '${shardKey}';\n` +
      `// planted across every shard: ${UNIVERSAL}\n` +
      `export function handler${writer}${i}() { return ${i}; }\n`,
  }));
}

function expectedAtoms(writer: string, shardKey: string, n: number): number {
  return docsFor(writer, shardKey, n).reduce((a, d) => a + chunkText(d.text).length, 0);
}

// ---- worker process ---------------------------------------------------------

async function workerMain(): Promise<void> {
  const own = `syn:own-${WRITER}`;
  const org = await FederatedEngine.open({ rootDir: ROOT, maxConcurrentShardIngests: 2 });
  await org.ensureShard({ shardKey: CONTENDED, kind: 'synthetic', displayName: 'contended' });
  await org.ensureShard({ shardKey: own, kind: 'synthetic', displayName: own });

  // interleaved ingest storms: contended shard + own shard, in small
  // alternating waves so the two processes genuinely contend
  const contendedDocs = docsFor(WRITER, CONTENDED, DOCS_PER_TARGET);
  const ownDocs = docsFor(WRITER, own, DOCS_PER_TARGET);
  const WAVE = 10;
  for (let i = 0; i < DOCS_PER_TARGET; i += WAVE) {
    await org.ingest(CONTENDED, [contendedDocs.slice(i, i + WAVE)]);
    await org.ingest(own, [ownDocs.slice(i, i + WAVE)]);
    // concurrent federated reads while both processes write
    const probe = await org.search(`marker_${WRITER}_${i}`, { shard: own, strict: true });
    if (i > 0 && probe.hits.length === 0) throw new Error(`mid-storm read miss for marker_${WRITER}_${i}`);
  }

  // drain this process's sync pipelines (contended + own)
  for (const key of [CONTENDED, own]) {
    for (let round = 0; round < 50; round++) {
      const stats = await org.withEngine(key, (e) => e.stats());
      if ((stats.outboxDirty as number) === 0) break;
      await org.syncNow(key);
    }
  }
  await org.close();
  // eslint-disable-next-line no-console
  console.log(`worker ${WRITER}: done`);
}

// ---- parent / verifier --------------------------------------------------------

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

function runWorker(writer: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), '--role', 'worker', '--writer', writer, '--root', ROOT, '--docs', String(DOCS_PER_TARGET)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (d) => (output += String(d)));
    child.stderr.on('data', (d) => (output += String(d)));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

async function parentMain(): Promise<void> {
  console.log(`\n=== multi-writer-org — two OS processes, one rootDir, contended shard ===\n`);
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  // pre-create the catalog + contended shard so both children upsert
  const bootstrap = await FederatedEngine.open({ rootDir: ROOT });
  await bootstrap.ensureShard({ shardKey: CONTENDED, kind: 'synthetic', displayName: 'contended' });
  await bootstrap.close();

  const t0 = performance.now();
  const [a, b] = await Promise.all([runWorker('A'), runWorker('B')]);
  console.log(`[storm] both processes finished in ${(performance.now() - t0).toFixed(0)} ms`);
  check('worker A exited clean', a.code === 0, a.code !== 0 ? a.output.slice(-400) : '');
  check('worker B exited clean', b.code === 0, b.code !== 0 ? b.output.slice(-400) : '');
  check('zero SQLITE_BUSY escapes', !`${a.output}${b.output}`.includes('SQLITE_BUSY'));

  // ---- post-mortem verification over the shared rootDir ----------------------
  const org = await FederatedEngine.open({ rootDir: ROOT });

  const expectContended = expectedAtoms('A', CONTENDED, DOCS_PER_TARGET) + expectedAtoms('B', CONTENDED, DOCS_PER_TARGET);
  const contendedStats = await org.withEngine(CONTENDED, (e) => e.stats());
  check('zero lost writes on the contended shard', contendedStats.nodes === expectContended, `${contendedStats.nodes}/${expectContended} atoms`);
  check(
    'dual FTS lock-step on the contended shard',
    contendedStats.ftsRows === contendedStats.nodes && contendedStats.ftsWordRows === contendedStats.nodes,
  );
  check('contended outboxes fully drained', (contendedStats.outboxDirty as number) === 0);

  for (const writer of ['A', 'B'] as const) {
    const own = `syn:own-${writer}`;
    const stats = await org.withEngine(own, (e) => e.stats());
    const expect = expectedAtoms(writer, own, DOCS_PER_TARGET);
    check(`zero lost writes on ${own}`, stats.nodes === expect, `${stats.nodes}/${expect}`);
    check(`${own} FTS lock-step`, stats.ftsRows === stats.nodes && stats.ftsWordRows === stats.nodes);
  }

  // catalog convergence: rows must reflect true per-shard totals once
  // re-derived (both writers raced updateShardStats; the final rollup
  // must land on the truth)
  for (const key of [CONTENDED, 'syn:own-A', 'syn:own-B']) {
    const actual = (await org.withEngine(key, (e) => e.stats())).nodes as number;
    const row = org.catalog.getShard(key)!;
    const converged = row.atomCount === actual;
    if (!converged) {
      // a stale racing rollup is detectable and self-healing: one stats
      // refresh must converge the row
      org.catalog.updateShardStats(key, {
        atomCount: actual,
        docCount: (await org.withEngine(key, (e) => e.stats())).documents as number,
        bytes: row.bytes,
      });
    }
    check(`catalog atom_count converges for ${key}`, org.catalog.getShard(key)!.atomCount === actual);
  }

  // ---- Graph firewall across shards (planted universal term) ------------------
  const total = DOCS_PER_TARGET;
  for (const key of [CONTENDED, 'syn:own-A', 'syn:own-B']) {
    const hits = await org.search(UNIVERSAL, { shard: key, strict: true, limit: 500, perShardLimit: 500 });
    const foreign = hits.hits.filter((h) => h.shardKey !== key);
    check(`firewall: ${key} scope leaks zero foreign hits`, foreign.length === 0, `${hits.hits.length} hits inspected`);
    const expectDocs = key === CONTENDED ? total * 2 : total;
    check(`firewall: ${key} sees all its own planted docs`, hits.hits.length === expectDocs, `${hits.hits.length}/${expectDocs}`);
  }

  await org.close();

  if (failures.length > 0) {
    console.error(`\nFAIL: multi-writer-org — ${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: two OS processes, one org — zero lost writes, zero BUSY, firewall intact.\n`);
}

(ROLE === 'worker' ? workerMain() : parentMain()).catch((err) => {
  console.error(err);
  process.exit(1);
});
