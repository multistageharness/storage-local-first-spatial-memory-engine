/**
 * org-incremental (IDEA.v2 §9.2) — full synthetic-org ingest → mutate 1%
 * of documents (seeded) → re-crawl.
 *
 * Proves: ≥ 99% hash-skip on unchanged content, changed docs re-indexed
 * (new content findable, old content gone — FTS delete hygiene), a
 * 1-doc delta lands in ≤ 2 s end-to-end, and cursor crash-replay is
 * idempotent (replaying the last committed batch yields pure skips).
 *
 * Usage: node dist/integration/org-incremental.js
 *          [--shards 48] [--docs-per-shard 40] [--root path] [--report path]
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FederatedEngine } from '../dist/src/federated-engine.js';
import { buildSyntheticOrg, mulberry32 } from '../__test__/benchmark/org-dataset.js';
import type { SourceDocumentInput } from '../dist/src/engine.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const SHARDS = Number(arg('shards', '48'));
const DOCS_PER_SHARD = Number(arg('docs-per-shard', '40'));
const ROOT = arg('root', join(process.cwd(), '.data', 'org-incremental'));
const REPORT = arg('report', join(process.cwd(), 'reports', 'org-incremental-report.json'));

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(`${name}${detail ? ` (${detail})` : ''}`);
}
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 1 });

async function main(): Promise<void> {
  console.log(`\n=== org-incremental — ${SHARDS} shards × ${DOCS_PER_SHARD} docs, 1% seeded mutation ===\n`);
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  const org = buildSyntheticOrg({ seed: 42, shards: SHARDS, docsPerShard: DOCS_PER_SHARD });
  const engine = await FederatedEngine.open({ rootDir: ROOT, maxConcurrentShardIngests: 8 });

  for (const s of org.shards) {
    await engine.ensureShard({ shardKey: s.shardKey, kind: 'synthetic', displayName: s.displayName, clusters: s.clusters });
  }
  const fullReports = await Promise.all(org.shards.map((s) => engine.ingest(s.shardKey, [s.docs])));
  const totalDocs = fullReports.reduce((a, r) => a + r.docs, 0);
  console.log(`[full] ${fmt(totalDocs)} docs ingested`);

  // ---- mutate exactly 1% of docs (seeded) -----------------------------------
  const rnd = mulberry32(0x1ce);
  const mutated: { shardKey: string; doc: SourceDocumentInput; oldNeedle: string; newMarker: string }[] = [];
  const target = Math.max(1, Math.round(totalDocs * 0.01));
  while (mutated.length < target) {
    const shard = org.shards[Math.floor(rnd() * org.shards.length)];
    const idx = Math.floor(rnd() * shard.docs.length);
    const doc = shard.docs[idx];
    if (mutated.some((m) => m.shardKey === shard.shardKey && m.doc.sourceKey === doc.sourceKey)) continue;
    const newMarker = `mutatedMarker_${mutated.length}_${shard.codename}`;
    const newDoc: SourceDocumentInput = {
      ...doc,
      // the needle is REPLACED — old content must become unfindable
      text: doc.text.replace(doc.needle, newMarker),
      contentHash: undefined,
    };
    shard.docs[idx] = { ...doc, text: newDoc.text };
    mutated.push({ shardKey: shard.shardKey, doc: newDoc, oldNeedle: doc.needle, newMarker });
  }
  console.log(`[mutate] ${mutated.length} docs (1%) rewritten`);

  // ---- delta: re-crawl the whole org ------------------------------------------
  const t0 = performance.now();
  const deltaReports = await Promise.all(org.shards.map((s) => engine.ingest(s.shardKey, [s.docs])));
  const deltaMs = performance.now() - t0;
  const skipped = deltaReports.reduce((a, r) => a + r.skippedDocs, 0);
  const reindexed = totalDocs - skipped;
  const skipRate = skipped / (totalDocs - mutated.length);
  console.log(`[delta] re-crawl in ${fmt(deltaMs)} ms — ${fmt(skipped)} skipped, ${reindexed} re-indexed`);

  check('≥ 99% hash-skip on unchanged content', skipRate >= 0.99, `${(skipRate * 100).toFixed(2)}%`);
  check('only the mutated docs re-indexed', reindexed === mutated.length, `${reindexed}/${mutated.length}`);

  let newFound = 0;
  let oldGone = 0;
  for (const m of mutated) {
    if ((await engine.search(m.newMarker, { shard: m.shardKey, strict: true })).hits.length > 0) newFound++;
    if ((await engine.search(m.oldNeedle, { shard: m.shardKey, strict: true })).hits.length === 0) oldGone++;
  }
  check('new content findable', newFound === mutated.length, `${newFound}/${mutated.length}`);
  check('old content gone (FTS delete hygiene)', oldGone === mutated.length, `${oldGone}/${mutated.length}`);

  // ---- 1-doc delta latency ------------------------------------------------------
  const one = mutated[0];
  const oneDoc: SourceDocumentInput = { ...one.doc, text: one.doc.text + '\n// one more line', contentHash: undefined };
  const t1 = performance.now();
  await engine.ingest(one.shardKey, [[oneDoc]]);
  const oneMs = performance.now() - t1;
  check('1-doc delta ≤ 2 s end-to-end', oneMs <= 2000, `${fmt(oneMs)} ms`);

  // ---- cursor crash-replay: replay the last "batch" → pure skips ------------------
  const lastShard = org.shards[org.shards.length - 1];
  const replay = await engine.ingest(lastShard.shardKey, [lastShard.docs.slice(-10)]);
  check('cursor crash-replay idempotent', replay.skippedDocs === Math.min(10, lastShard.docs.length), `${replay.skippedDocs} skips, ${replay.atoms} new atoms`);

  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(
    REPORT,
    JSON.stringify(
      { shards: SHARDS, totalDocs, mutated: mutated.length, skipRate, oneDocDeltaMs: Math.round(oneMs), failures },
      null,
      2,
    ),
  );
  await engine.close();

  if (failures.length > 0) {
    console.error(`\nFAIL: org-incremental — ${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: incremental ingest — ${(skipRate * 100).toFixed(2)}% skip, deltas ∝ change set, replay idempotent.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
