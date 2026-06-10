/**
 * soak (IDEA.v2 §9.2 — nightly, not in `make all`) — a duration-bounded
 * loop of rolling delta ingests + query storms + sync rounds + GC over a
 * multi-shard org.
 *
 * Asserts at exit: RSS plateau (final RSS ≤ 1.3 × steady-state), WAL
 * files bounded, CRDT blob sizes bounded by GC, zero errors across the
 * whole run.
 *
 * Usage: node dist/integration/soak.js
 *          [--minutes 240] [--shards 64] [--root path] [--report path]
 * CI smoke profile: --minutes 1 --shards 16
 */
import { mkdirSync, rmSync, statSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FederatedEngine } from '../src/federated-engine.js';
import { buildSyntheticOrg, mulberry32, synthesizeOrgQueries } from '../__test__/benchmark/org-dataset.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const MINUTES = Number(arg('minutes', '240'));
const SHARDS = Number(arg('shards', '64'));
const ROOT = arg('root', join(process.cwd(), '.data', 'soak'));
const REPORT = arg('report', join(process.cwd(), 'reports', 'soak-report.json'));

const fmtMb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;

function walBytes(root: string): number {
  const dir = join(root, 'shards');
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const f of readdirSync(dir)) {
    if (f.endsWith('-wal')) total += statSync(join(dir, f)).size;
  }
  return total;
}

async function main(): Promise<void> {
  console.log(`\n=== soak — ${MINUTES} min loop over ${SHARDS} shards ===\n`);
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  const org = buildSyntheticOrg({ seed: 42, shards: SHARDS, docsPerShard: 20 });
  const engine = await FederatedEngine.open({
    rootDir: ROOT,
    maxOpenShards: Math.min(96, SHARDS + 8),
    maxConcurrentShardIngests: 4,
  });
  for (const s of org.shards) {
    await engine.ensureShard({ shardKey: s.shardKey, kind: 'synthetic', displayName: s.displayName, clusters: s.clusters });
    await engine.ingest(s.shardKey, [s.docs]);
  }
  engine.catalog.refreshAllRoutingTerms();
  const queries = synthesizeOrgQueries(org, 200);

  const deadline = Date.now() + MINUTES * 60_000;
  const rnd = mulberry32(0x50a3);
  const rssSamples: number[] = [];
  let rounds = 0;
  let errors = 0;
  let merged = 0;
  let compacted = 0;

  while (Date.now() < deadline) {
    rounds++;
    try {
      // rolling delta: mutate ~2% of one shard's docs
      const shard = org.shards[Math.floor(rnd() * org.shards.length)];
      const mutCount = Math.max(1, Math.floor(shard.docs.length * 0.02));
      const docs = Array.from({ length: mutCount }, () => {
        const d = shard.docs[Math.floor(rnd() * shard.docs.length)];
        return { ...d, text: `${d.text}\n// soak round ${rounds}`, contentHash: undefined };
      });
      await engine.ingest(shard.shardKey, [docs]);

      // query storm slice
      const slice = Array.from({ length: 25 }, () => queries[Math.floor(rnd() * queries.length)]);
      await Promise.all(slice.map((q) => engine.search(q.query, { limit: 10, maxShards: 32 })));

      // sync + epoch GC on the touched shard (engine.syncNow runs the
      // gcBlobThreshold sweep)
      const sync = await engine.withEngine(shard.shardKey, (e) => e.syncNow());
      merged += sync.merged;
      compacted += sync.compacted ?? 0;
    } catch (err) {
      errors++;
      console.error(`[round ${rounds}] error: ${(err as Error).message}`);
    }
    rssSamples.push(process.memoryUsage().rss);
    if (rounds % 25 === 0) {
      console.log(
        `[round ${rounds}] rss=${fmtMb(rssSamples[rssSamples.length - 1])} wal=${fmtMb(walBytes(ROOT))} merged=${merged} compacted=${compacted}`,
      );
    }
  }

  // steady-state = median of the middle half of samples
  const sorted = [...rssSamples].sort((a, b) => a - b);
  const steady = sorted[Math.floor(sorted.length / 2)];
  const finalRss = rssSamples[rssSamples.length - 1];
  const wal = walBytes(ROOT);

  // blob sizes bounded by GC: no atom blob may exceed 2× the 64 KiB threshold
  let maxBlob = 0;
  for (const s of org.shards.slice(0, Math.min(8, org.shards.length))) {
    const stats = await engine.withEngine(s.shardKey, async (e) => {
      const { compacted: swept } = await e.compactAtoms({ maxBlobBytes: 64 * 1024, limit: 10 });
      return swept;
    });
    for (const c of stats) maxBlob = Math.max(maxBlob, c.bytesBefore);
  }
  await engine.close();

  const checks: [string, boolean, string][] = [
    ['zero errors', errors === 0, `${errors} errors over ${rounds} rounds`],
    ['RSS plateau', finalRss <= steady * 1.3, `final ${fmtMb(finalRss)} ≤ 1.3 × steady ${fmtMb(steady)}`],
    ['WAL bounded', wal < 256 * 1024 * 1024, `${fmtMb(wal)} < 256 MB`],
    ['blob sizes bounded by GC', maxBlob <= 2 * 64 * 1024, `max pre-sweep blob ${fmtMb(maxBlob)}`],
  ];
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(
    REPORT,
    JSON.stringify({ minutes: MINUTES, shards: SHARDS, rounds, merged, compacted, errors, steadyRss: steady, finalRss, walBytes: wal }, null, 2),
  );
  for (const [name, ok, detail] of checks) console.log(`  ${ok ? '✓' : '✗'} ${name} — ${detail}`);
  if (checks.some(([, ok]) => !ok)) {
    console.error(`\nFAIL: soak invariants violated.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${rounds} soak rounds — RSS plateaued, WAL and blobs bounded, zero errors.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
