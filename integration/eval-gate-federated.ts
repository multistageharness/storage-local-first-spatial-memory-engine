/**
 * eval-gate-federated (IDEA.v2 §9.2) — federated goldens over a live
 * 8-shard org. Any failing golden blocks with router/retriever/generator
 * attribution printed (three-component isolation, IDEA.v2 §10.3).
 * --jury swaps the single LexicalJudge for a JudgeJury (DEMO001 §8.2).
 *
 * Usage: node dist/integration/eval-gate-federated.js
 *          [--jury] [--shards 8] [--goldens 16] [--root path] [--report path]
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FederatedEngine } from '../dist/src/federated-engine.js';
import { buildSyntheticOrg } from '../__test__/benchmark/org-dataset.js';
import {
  FederatedEvalHarness,
  synthesizeFederatedGoldens,
} from '../__test__/eval/federated.js';
import { JudgeJury, LexicalJudge } from '../__test__/eval/judge.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const SHARDS = Number(arg('shards', '8'));
const GOLDENS = Number(arg('goldens', '16'));
const ROOT = arg('root', join(process.cwd(), '.data', 'eval-federated'));
const REPORT = arg('report', join(process.cwd(), 'reports', 'eval-federated-report.json'));
const JURY = process.argv.includes('--jury');

async function main(): Promise<void> {
  console.log(`\n=== eval-gate-federated — ${GOLDENS} goldens over a live ${SHARDS}-shard org${JURY ? ' (jury)' : ''} ===\n`);
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  const synth = buildSyntheticOrg({ seed: 11, shards: SHARDS, docsPerShard: 12 });
  const org = await FederatedEngine.open({ rootDir: ROOT, maxConcurrentShardIngests: 4 });
  for (const s of synth.shards) {
    await org.ensureShard({ shardKey: s.shardKey, kind: 'synthetic', displayName: s.displayName, clusters: s.clusters });
    await org.ingest(s.shardKey, [s.docs]);
  }
  org.catalog.refreshAllRoutingTerms();

  const corpora = synth.shards.map((s) => ({
    shardKey: s.shardKey,
    docs: s.docs.map((d) => ({ title: d.title, text: d.text, originFile: d.originFile })),
  }));
  const goldens = synthesizeFederatedGoldens(corpora, { seed: 5, maxGoldens: GOLDENS });
  console.log(
    `[goldens] ${goldens.length} synthesized — ` +
      `${goldens.filter((g) => g.evolutions.includes('cross-shard-multi-context')).length} cross-shard`,
  );

  const judge = JURY
    ? new JudgeJury([new LexicalJudge(), new LexicalJudge({ attributionThreshold: 0.6 }), new LexicalJudge({ relevanceThreshold: 0.15 })])
    : new LexicalJudge();
  const harness = new FederatedEvalHarness({ org, judge });
  const report = await harness.run(goldens);

  console.log(`[judge] ${report.judge}`);
  console.log(`[metrics] means: ${JSON.stringify(report.metricMeans)}`);
  console.log(
    `[attribution] router=${report.componentFailures.router} retriever=${report.componentFailures.retriever} generator=${report.componentFailures.generator}`,
  );
  for (const c of report.cases.filter((c) => !c.passed)) {
    console.error(`  ✗ "${c.input.slice(0, 80)}…"`);
    for (const m of c.metrics.filter((m) => !m.passed)) {
      console.error(`      ${m.name} [${m.component}] ${m.score} < ${m.threshold}: ${m.reason}`);
    }
  }

  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  await org.close();

  if (!report.passed) {
    console.error(`\nFAIL: ${report.totals.failed}/${report.totals.cases} federated goldens failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: ${report.totals.passed}/${report.totals.cases} federated goldens green (router/retriever/generator all clean).\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
