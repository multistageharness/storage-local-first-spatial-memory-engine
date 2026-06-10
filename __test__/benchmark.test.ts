/**
 * Benchmark tests — the curated golden-dataset runner over a LIVE engine:
 * distribution-band enforcement, annotation-exact retrieval scoring,
 * refusal gating for no-answer cases, distractor resistance, and the
 * model-separation guard.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEngine } from '../src/engine.js';
import {
  BenchmarkRunner,
  validateDistribution,
  type BenchmarkCase,
  type BenchmarkReport,
} from './eval/benchmark.js';
import { benchmarkRetriever, type BenchmarkRetrieveFn } from './eval/retriever.js';
import { abstainingGenerator, hallucinatingGenerator, isRefusal, REFUSAL_TEXT } from './eval/generator.js';
import { LexicalJudge } from './eval/judge.js';
import { benchmarkDataset } from './benchmark/dataset.js';

const dir = mkdtempSync(join(tmpdir(), 'sme-bench-'));
let engine: MemoryEngine;
let retrieve: BenchmarkRetrieveFn;
let report: BenchmarkReport;

before(async () => {
  engine = await MemoryEngine.open({ dbPath: join(dir, 'bench.db'), graph: 'bench', minReaders: 2 });
  for (const doc of benchmarkDataset.corpus) await engine.ingestDocument(doc);
  retrieve = benchmarkRetriever(engine, { limit: 5 });
  report = await new BenchmarkRunner({ retrieve }).run(benchmarkDataset);
});

after(async () => {
  await engine.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---- distribution validation ---------------------------------------------------

test('distribution: curated dataset sits inside the recommended bands', () => {
  const d = validateDistribution(benchmarkDataset.cases);
  assert.ok(d.ok, d.violations.join('; '));
  assert.equal(d.counts.common, 11);
  assert.equal(d.counts.distractor, 5);
  assert.equal(d.counts['multi-hop'], 2);
  assert.equal(d.counts['no-answer'], 2);
});

test('distribution: all-common dataset violates every other band', () => {
  const common = benchmarkDataset.cases.filter((c) => c.metadata.queryType === 'common');
  const d = validateDistribution(common);
  assert.ok(!d.ok);
  // common itself is over 60%, and the three other categories are at 0%
  assert.equal(d.violations.length, 4, d.violations.join('; '));
});

test('distribution: empty dataset is rejected', () => {
  assert.ok(!validateDistribution([]).ok);
});

// ---- the full benchmark run ------------------------------------------------------

test('benchmark: full curated run passes every case and every band', async (t) => {
  for (const c of report.cases) {
    await t.test(`${c.id}: ${c.input.slice(0, 60)}`, () => {
      assert.ok(
        c.passed,
        c.metrics.filter((m) => !m.passed).map((m) => `${m.name} ${m.score} < ${m.threshold}: ${m.reason}`).join('; '),
      );
    });
  }
  assert.ok(report.passed);
  assert.equal(report.totals.failed, 0);
  assert.ok(report.distribution.ok);
  // per-type pass rates are fully populated
  for (const type of ['common', 'distractor', 'multi-hop', 'no-answer'] as const) {
    assert.equal(report.perType[type].passed, report.perType[type].cases);
    assert.ok(report.perType[type].cases > 0);
  }
});

test('benchmark: distractor cases retrieve the lure but rank the authoritative doc first', async () => {
  for (const c of benchmarkDataset.cases.filter((x) => x.metadata.queryType === 'distractor')) {
    const lure = c.metadata.tags?.find((t) => t.startsWith('lure:'))?.slice('lure:'.length);
    assert.ok(lure, `${c.id} must annotate its lure document`);
    const docs = (await retrieve(c.input)).map((r) => r.docId);
    assert.ok(docs.includes(lure), `${c.id}: lure ${lure} must actually be retrieved (else the case tests nothing)`);
    assert.ok(
      docs.indexOf(c.supportingDocs[0]) < docs.indexOf(lure),
      `${c.id}: supporting doc must outrank the lure`,
    );
  }
});

test('benchmark: multi-hop cases require both supporting docs (docRecall = 1)', () => {
  for (const r of report.cases.filter((c) => c.queryType === 'multi-hop')) {
    const recall = r.metrics.find((m) => m.name === 'docRecall')!;
    assert.equal(recall.score, 1, `${r.id}: ${recall.reason}`);
    const c = benchmarkDataset.cases.find((x) => x.id === r.id)!;
    assert.ok(c.supportingDocs.length >= 2, 'multi-hop must span 2+ docs');
  }
});

// ---- no-answer behavior -------------------------------------------------------------

test('no-answer: abstaining generator refuses, fabricating generator is caught', async () => {
  const noAnswer = benchmarkDataset.cases.filter((c) => !c.metadata.answerable);
  assert.ok(noAnswer.length >= 2);

  // correct behavior: refusal passes
  for (const r of report.cases.filter((c) => c.queryType === 'no-answer')) {
    assert.ok(isRefusal(r.actualOutput), `${r.id} must refuse, got "${r.actualOutput.slice(0, 60)}"`);
    assert.ok(r.passed);
  }

  // wrong behavior: a generator that always fabricates must fail the refusal gate
  const fabricator = new BenchmarkRunner({
    retrieve,
    generate: () => 'The managed hosting plan is priced at $99 per month with the autoscaler included.',
  });
  for (const c of noAnswer) {
    const r = await fabricator.runCase(c);
    assert.ok(!r.passed, `${c.id}: fabricated answer must fail`);
    const refusal = r.metrics.find((m) => m.name === 'refusal')!;
    assert.equal(refusal.score, 0);
    assert.match(refusal.reason, /hallucination/);
  }
});

test('no-answer: refusal on an ANSWERABLE question fails answerCorrectness', async () => {
  const runner = new BenchmarkRunner({ retrieve, generate: () => REFUSAL_TEXT });
  const c = benchmarkDataset.cases.find((x) => x.id === 'common-01')!;
  const r = await runner.runCase(c);
  assert.ok(!r.passed);
  const correctness = r.metrics.find((m) => m.name === 'answerCorrectness')!;
  assert.equal(correctness.score, 0);
  assert.match(correctness.reason, /refused an answerable question/);
});

// ---- generator quality gates ----------------------------------------------------------

test('benchmark: hallucinating generator fails faithfulness on answerable cases', async () => {
  const runner = new BenchmarkRunner({
    retrieve,
    generate: hallucinatingGenerator(abstainingGenerator()),
    thresholds: { faithfulness: 0.9 },
  });
  const c = benchmarkDataset.cases.find((x) => x.id === 'common-01')!;
  const r = await runner.runCase(c);
  const f = r.metrics.find((m) => m.name === 'faithfulness')!;
  assert.ok(!f.passed, `injected claim must fail faithfulness, got ${f.score}`);
});

test('benchmark: docRecall fails when a supporting doc is renamed away', async () => {
  const c = benchmarkDataset.cases.find((x) => x.id === 'common-01')!;
  const broken: BenchmarkCase = { ...c, supportingDocs: ['nonexistent-doc.md'] };
  const r = await new BenchmarkRunner({ retrieve }).runCase(broken);
  const recall = r.metrics.find((m) => m.name === 'docRecall')!;
  assert.equal(recall.score, 0);
  assert.match(recall.reason, /missing supporting doc/);
});

// ---- model separation ---------------------------------------------------------------------

test('separation: judge matching dataset provenance is refused (self-preference bias)', async () => {
  const judge = new LexicalJudge();
  const tainted = {
    ...benchmarkDataset,
    provenance: { curatedBy: 'human-sme', generatedBy: judge.name },
  };
  const runner = new BenchmarkRunner({ retrieve, judge });
  await assert.rejects(() => runner.run(tainted), /model separation violated/);
  // distinct judge family: same dataset runs fine
  const distinct = new BenchmarkRunner({ retrieve, judge: new LexicalJudge({ attributionThreshold: 0.6 }) });
  const ok = await distinct.run(tainted);
  assert.ok(ok.totals.cases > 0);
});
