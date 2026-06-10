/**
 * benchmark-org-gate (IDEA.v2 §10.4) — the three federated benchmark
 * datasets executed against live FederatedEngines:
 *
 *   - org-synthetic-v2: five-band distribution (cross-shard [0.1,0.2]),
 *     near-collision lures, shardKey:path doc ids;
 *   - confluence-fixture-v2: curated cases over the fixture site,
 *     crawled in through the real connector (code macros verbatim);
 *   - repo-org-v2: per-shard auto-annotated cases over synthetic repo
 *     corpora, merged with shard attribution.
 *
 * Usage: node dist/integration/benchmark-org-gate.js [--jury] [--root path] [--report path]
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FederatedEngine } from '../src/federated-engine.js';
import { ConfluenceConnector } from '../src/connectors/confluence.js';
import { runOrgCrawl } from '../src/connectors/runner.js';
import { buildSyntheticOrg } from '../__test__/benchmark/org-dataset.js';
import {
  buildConfluenceFixtureDataset,
  buildOrgSyntheticDataset,
  buildRepoOrgDataset,
} from '../__test__/benchmark/org-benchmark.js';
import { FixtureConfluenceServer, buildFixtureSite } from '../__test__/fixtures/confluence-fixture-server.js';
import {
  BenchmarkRunner,
  FEDERATED_DISTRIBUTION_BANDS,
  type BenchmarkReport,
} from '../__test__/eval/benchmark.js';
import { federatedBenchmarkRetriever } from '../__test__/eval/federated.js';
import { JudgeJury, LexicalJudge } from '../__test__/eval/judge.js';
import type { CorpusDoc } from '../__test__/eval/goldens.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const ROOT = arg('root', join(process.cwd(), '.data', 'benchmark-org'));
const REPORT = arg('report', join(process.cwd(), 'reports', 'benchmark-org-report.json'));
const JURY = process.argv.includes('--jury');

function judge() {
  return JURY ? new JudgeJury([new LexicalJudge(), new LexicalJudge({ attributionThreshold: 0.6 })]) : new LexicalJudge();
}

function summarize(report: BenchmarkReport): string {
  const types = Object.entries(report.perType)
    .filter(([, v]) => v.cases > 0)
    .map(([k, v]) => `${k} ${v.passed}/${v.cases}`)
    .join(', ');
  return `${report.totals.passed}/${report.totals.cases} (${types})`;
}

async function main(): Promise<void> {
  console.log(`\n=== benchmark-org-gate — three federated datasets vs live engines ===\n`);
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const reports: Record<string, BenchmarkReport> = {};

  // ---- 1. org-synthetic-v2 ---------------------------------------------------
  {
    const synth = buildSyntheticOrg({ seed: 3, shards: 10, docsPerShard: 12 });
    const org = await FederatedEngine.open({ rootDir: join(ROOT, 'org'), maxConcurrentShardIngests: 4 });
    for (const s of synth.shards) {
      await org.ensureShard({ shardKey: s.shardKey, kind: 'synthetic', displayName: s.displayName, clusters: s.clusters });
      await org.ingest(s.shardKey, [s.docs]);
    }
    org.catalog.refreshAllRoutingTerms();
    const runner = new BenchmarkRunner({
      retrieve: federatedBenchmarkRetriever(org),
      judge: judge(),
      bands: FEDERATED_DISTRIBUTION_BANDS,
    });
    reports['org-synthetic-v2'] = await runner.run(buildOrgSyntheticDataset(synth, { seed: 3 }));
    await org.close();
    console.log(`[org-synthetic-v2] ${summarize(reports['org-synthetic-v2'])}`);
  }

  // ---- 2. confluence-fixture-v2 (through the real connector) -------------------
  {
    const site = buildFixtureSite();
    const server = new FixtureConfluenceServer(site);
    const baseUrl = await server.start();
    const org = await FederatedEngine.open({ rootDir: join(ROOT, 'confluence'), maxConcurrentShardIngests: 3 });
    const connector = new ConfluenceConnector({ baseUrl, ratePerSec: 200, batchSize: 25 });
    await runOrgCrawl(org, connector, { mode: 'full' });
    const runner = new BenchmarkRunner({ retrieve: federatedBenchmarkRetriever(org), judge: judge() });
    reports['confluence-fixture-v2'] = await runner.run(buildConfluenceFixtureDataset(site));
    await org.close();
    await server.stop();
    console.log(`[confluence-fixture-v2] ${summarize(reports['confluence-fixture-v2'])}`);
  }

  // ---- 3. repo-org-v2 (per-shard auto-annotation, merged) ------------------------
  {
    const SERVICES = ['payments', 'identity', 'search', 'mailer', 'gateway', 'ledger', 'webapp', 'mobile-api', 'etl', 'metrics', 'docs-site', 'cli'];
    const mkCorpus = (tag: string): CorpusDoc[] => {
      const safe = tag.replace(/-/g, '_');
      const docs: CorpusDoc[] = Array.from({ length: 8 }, (_, f) => ({
        title: `src/${safe}${f}.ts`,
        originFile: `src/${safe}${f}.ts`,
        text: [
          `export function ${safe}Handler${f}(req: Request) {`,
          `  return dispatch_${safe}_${f}(req);`,
          `}`,
          `export const ${safe}Config${f} = { retries: ${f} };`,
        ].join('\n'),
      }));
      docs.push({
        title: `src/${safe}Index.ts`,
        originFile: `src/${safe}Index.ts`,
        text: [
          `import { ${safe}Handler0 } from './${safe}0.js';`,
          `import { ${safe}Handler1 } from './${safe}1.js';`,
          `export const routes = [${safe}Handler0, ${safe}Handler1];`,
          `export const wired = ${safe}Config2 != null;`,
        ].join('\n'),
      });
      return docs;
    };
    const shards = SERVICES.map((name) => ({ shardKey: `gh:acme/${name}`, corpus: mkCorpus(name) }));

    const org = await FederatedEngine.open({ rootDir: join(ROOT, 'repos'), maxConcurrentShardIngests: 6 });
    for (const s of shards) {
      await org.ensureShard({ shardKey: s.shardKey, kind: 'repo', displayName: s.shardKey });
      await org.ingest(s.shardKey, [
        s.corpus.map((d) => ({ sourceKey: d.originFile!, title: d.title, text: d.text, originFile: d.originFile })),
      ]);
    }
    org.catalog.refreshAllRoutingTerms();
    const runner = new BenchmarkRunner({ retrieve: federatedBenchmarkRetriever(org), judge: judge() });
    reports['repo-org-v2'] = await runner.run(buildRepoOrgDataset(shards, { seed: 7, casesPerShard: 8 }));
    await org.close();
    console.log(`[repo-org-v2] ${summarize(reports['repo-org-v2'])}`);
  }

  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, JSON.stringify(reports, null, 2));

  const failed = Object.entries(reports).filter(([, r]) => !r.passed);
  for (const [name, r] of failed) {
    console.error(`\n✗ ${name}: distribution ok=${r.distribution.ok} ${r.distribution.violations.join('; ')}`);
    for (const c of r.cases.filter((c) => !c.passed)) {
      console.error(`    ${c.id}: ${c.metrics.filter((m) => !m.passed).map((m) => `${m.name}=${m.score} (${m.reason})`).join('; ')}`);
    }
  }
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/3 federated benchmark datasets failed.`);
    process.exit(1);
  }
  console.log(`\nPASS: all three federated benchmark datasets green.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
