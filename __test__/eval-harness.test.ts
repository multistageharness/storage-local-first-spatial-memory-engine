/**
 * Integration tests — the RAG eval harness over a LIVE engine, per the
 * guide's dynamic-execution rule: goldens are static, but every retrieval
 * context and actual output is produced at test time by querying the real
 * FTS5 pipeline. Includes the parametrized golden loop (the node:test
 * equivalent of @pytest.mark.parametrize + assert_test) and negative
 * controls proving each gate actually catches its failure mode.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEngine } from '../src/engine.js';
import { synthesizeGoldens, type CorpusDoc, type Golden } from './eval/goldens.js';
import { RagEvalHarness, assertCase, type RetrieveFn } from './eval/harness.js';
import { engineRetriever } from './eval/retriever.js';
import { hallucinatingGenerator } from './eval/generator.js';
import { LexicalJudge, JudgeJury } from './eval/judge.js';

// ---- corpus: distinct domains so retrieval is non-trivial -------------------

const corpus: CorpusDoc[] = [
  {
    title: 'auth-service.ts',
    originFile: 'src/auth-service.ts',
    text: 'export function validateSessionToken(token) { return verifySignature(token); } The validateSessionToken helper rejects expired session credentials and refreshes the login state.',
  },
  {
    title: 'billing-service.ts',
    originFile: 'src/billing-service.ts',
    text: 'export function prorateRefund(invoice) { return invoice.total * remainingDays(); } The prorateRefund routine settles partial subscription charges against the open invoice.',
  },
  {
    title: 'storage-service.ts',
    originFile: 'src/storage-service.ts',
    text: 'export function verifyChecksum(blob) { return sha256(blob) === blob.manifestChecksum; } The verifyChecksum step guards multipart uploads before the bucket persists the blob.',
  },
  {
    title: 'network-client.ts',
    originFile: 'src/network-client.ts',
    text: 'export function dispatchRequest(route) { return socket.send(route, { timeout: backoffDelay() }); } The dispatchRequest wrapper retries on socket timeout with exponential backoff headers.',
  },
];

const dir = mkdtempSync(join(tmpdir(), 'sme-eval-'));
let engine: MemoryEngine;
let retrieve: RetrieveFn;
let goldens: Golden[];

before(async () => {
  engine = await MemoryEngine.open({
    dbPath: join(dir, 'eval.db'),
    graph: 'eval-graph',
    clusters: [
      { name: 'auth', keywords: ['login', 'password', 'token', 'session'] },
      { name: 'billing', keywords: ['invoice', 'payment', 'refund', 'charge'] },
    ],
    minReaders: 2,
  });
  for (const doc of corpus) await engine.ingestDocument(doc);
  // dynamic retrieval — question → keyword terms → live FTS5 → RRF fusion
  retrieve = engineRetriever(engine, { limit: 5 });
  goldens = synthesizeGoldens(corpus, { seed: 42, maxGoldens: 8 });
  assert.ok(goldens.length >= corpus.length - 1, 'synthesizer must yield a golden per document');
});

after(async () => {
  await engine.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---- the deployment-gate run --------------------------------------------------

test('harness: full golden run over live engine passes all four gates', async (t) => {
  const harness = new RagEvalHarness({ retrieve });
  const report = await harness.run(goldens);

  // parametrized per-golden boolean assertions, pytest-style
  for (const c of report.cases) {
    await t.test(`golden: ${c.input.slice(0, 70)}`, () => assertCase(c));
  }

  assert.ok(report.passed, `gate failed: ${JSON.stringify(report.metricMeans)}`);
  assert.equal(report.totals.failed, 0);
  assert.equal(report.componentFailures.retriever, 0);
  assert.equal(report.componentFailures.generator, 0);
  for (const name of ['contextualRecall', 'contextualPrecision', 'faithfulness', 'answerRelevancy']) {
    assert.ok(name in report.metricMeans, `report must aggregate ${name}`);
  }
});

test('harness: dynamic execution — index mutation immediately changes eval results', async () => {
  const harness = new RagEvalHarness({ retrieve });
  const golden: Golden = {
    input: 'What does rotateEncryptionKey do in key-service.ts?',
    expectedOutput: 'The rotateEncryptionKey task re-wraps stored secrets with the freshest master key.',
    sourceContexts: ['The rotateEncryptionKey task re-wraps stored secrets with the freshest master key.'],
    evolutions: [],
    quality: { selfContainment: 1, clarity: 1 },
  };

  // before ingestion: the knowledge does not exist → retrieval gap
  const beforeCase = await harness.runGolden(golden);
  const recallBefore = beforeCase.metrics.find((m) => m.name === 'contextualRecall')!;
  assert.ok(!recallBefore.passed, 'recall must fail before the document exists');
  assert.ok(beforeCase.failedComponents.includes('retriever'), 'failure must be attributed to the retriever');

  // live ingest — no golden changed, only the application state
  await engine.ingestDocument({
    title: 'key-service.ts',
    originFile: 'src/key-service.ts',
    text: 'export function rotateEncryptionKey() { /* … */ } The rotateEncryptionKey task re-wraps stored secrets with the freshest master key.',
  });

  const afterCase = await harness.runGolden(golden);
  const recallAfter = afterCase.metrics.find((m) => m.name === 'contextualRecall')!;
  assert.ok(recallAfter.passed, 'recall must pass once the document is dynamically retrievable');
});

// ---- negative controls: each gate catches its failure mode ---------------------

test('gate: hallucinating generator fails faithfulness and is attributed to the generator', async () => {
  const harness = new RagEvalHarness({
    retrieve,
    generate: hallucinatingGenerator(),
    thresholds: { faithfulness: 0.9 },
  });
  const report = await harness.run(goldens.slice(0, 3));
  assert.ok(!report.passed, 'hallucinated parametric claims must fail the gate');
  assert.ok(report.componentFailures.generator > 0, 'failure must be attributed to the generator');
  const failing = report.cases.flatMap((c) => c.metrics).filter((m) => !m.passed);
  assert.ok(failing.every((m) => m.component === 'generator'), 'retriever metrics must stay green');
  assert.throws(() => assertCase(report.cases.find((c) => !c.passed)!), /faithfulness \[generator\]/);
});

test('gate: noisy retriever degrades contextual precision (component isolation)', async () => {
  const noise = [
    'Cafeteria lunch menus rotate weekly across four unrelated cuisines.',
    'The office plant watering rota alternates between floors every Tuesday.',
    'Parking garage levels close sequentially for cleaning each month.',
  ];
  // noise injected ABOVE the real hits — recall intact, ranking ruined
  const noisyRetrieve: RetrieveFn = async (input) => [...noise, ...(await retrieve(input))];

  const clean = await new RagEvalHarness({ retrieve }).run(goldens.slice(0, 3));
  const noisy = await new RagEvalHarness({ retrieve: noisyRetrieve }).run(goldens.slice(0, 3));

  assert.ok(
    noisy.metricMeans.contextualPrecision < clean.metricMeans.contextualPrecision,
    'noise on top must lower rank-aware precision',
  );
  assert.ok(
    noisy.metricMeans.contextualRecall >= clean.metricMeans.contextualRecall - 1e-9,
    'recall must be unaffected — the facts are still present',
  );
});

test('harness: jury judge produces a gate-equivalent verdict to a single judge here', async () => {
  const jury = new JudgeJury([
    new LexicalJudge({ attributionThreshold: 0.6 }),
    new LexicalJudge({ attributionThreshold: 0.7 }),
    new LexicalJudge({ attributionThreshold: 0.8 }),
  ]);
  const report = await new RagEvalHarness({ retrieve, judge: jury }).run(goldens.slice(0, 3));
  assert.ok(report.passed, 'majority consensus of staggered jurors must still pass clean cases');
  assert.match(report.judge, /^jury\(/);
});
