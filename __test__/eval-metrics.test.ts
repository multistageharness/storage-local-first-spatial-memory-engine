/**
 * Unit tests — eval metric math, judge verdicts, jury consensus, and the
 * four-stage synthetic golden pipeline. Pure in-memory: no engine, no DB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosine, termVector, tokenize } from './eval/metrics.js';
import {
  answerRelevancy,
  contextualPrecision,
  contextualRecall,
  faithfulness,
} from './eval/metrics.js';
import { JudgeJury, LexicalJudge, type Judge } from './eval/judge.js';
import { critiqueInput, synthesizeGoldens, type CorpusDoc } from './eval/goldens.js';
import { extractiveGenerator, hallucinatingGenerator } from './eval/generator.js';

const judge = new LexicalJudge();

// ---- embedding primitives -------------------------------------------------

test('tokenize: splits camelCase identifiers and drops stopwords', () => {
  const tokens = tokenize('What does createSessionToken do in the auth module?');
  assert.ok(tokens.includes('create'));
  assert.ok(tokens.includes('session'));
  assert.ok(tokens.includes('token'));
  assert.ok(!tokens.includes('the'));
  assert.ok(!tokens.includes('what'));
});

test('cosine: identical texts score 1, disjoint texts score 0', () => {
  const a = termVector('validate the session token');
  assert.ok(Math.abs(cosine(a, termVector('validate the session token')) - 1) < 1e-9);
  assert.equal(cosine(a, termVector('prorate quarterly invoice refunds')), 0);
  assert.equal(cosine(termVector(''), a), 0);
});

// ---- retriever metrics ------------------------------------------------------

test('contextualRecall: 1.0 when every expected statement is in context', async () => {
  const r = await contextualRecall(
    {
      expectedOutput: 'The session token is validated by validateSessionToken.',
      retrievalContext: ['function validateSessionToken(token) { /* session token validated */ }'],
    },
    judge,
    0.7,
  );
  assert.equal(r.score, 1);
  assert.equal(r.component, 'retriever');
  assert.ok(r.passed);
});

test('contextualRecall: drops when a required fact is missing from context (retrieval gap)', async () => {
  const r = await contextualRecall(
    {
      expectedOutput:
        'The session token is validated by validateSessionToken. Refunds are prorated by prorateRefund using the quarterly invoice schedule.',
      retrievalContext: ['function validateSessionToken(token) { /* session token validated */ }'],
    },
    judge,
    0.9,
  );
  assert.ok(r.score < 1, 'missing billing fact must lower recall');
  assert.ok(!r.passed);
  assert.match(r.reason, /missing/);
});

test('contextualPrecision: 1.0 when relevant chunks are ranked on top', async () => {
  const r = await contextualPrecision(
    {
      input: 'What does validateSessionToken do?',
      expectedOutput: 'validateSessionToken checks the session token signature.',
      retrievalContext: [
        'validateSessionToken checks the session token signature before use.',
        'Completely unrelated prose about quarterly garden maintenance schedules.',
      ],
    },
    judge,
    0.5,
  );
  assert.equal(r.score, 1);
  assert.ok(r.passed);
});

test('contextualPrecision: penalizes relevant chunk buried beneath noise (rank-aware)', async () => {
  const buried = await contextualPrecision(
    {
      input: 'What does validateSessionToken do?',
      expectedOutput: 'validateSessionToken checks the session token signature.',
      retrievalContext: [
        'Completely unrelated prose about quarterly garden maintenance schedules.',
        'Another irrelevant paragraph describing cafeteria lunch menu rotations.',
        'validateSessionToken checks the session token signature before use.',
      ],
    },
    judge,
    0.5,
  );
  // single relevant chunk at rank 3 → precision@3 = 1/3
  assert.ok(Math.abs(buried.score - 1 / 3) < 1e-3, `expected ~0.333, got ${buried.score}`);
  assert.ok(!buried.passed);
});

test('contextualPrecision: 0 with empty or fully irrelevant context', async () => {
  const empty = await contextualPrecision(
    { input: 'q?', expectedOutput: 'validateSessionToken checks signatures.', retrievalContext: [] },
    judge,
    0.5,
  );
  assert.equal(empty.score, 0);
  const noise = await contextualPrecision(
    {
      input: 'What does validateSessionToken do?',
      expectedOutput: 'validateSessionToken checks the session token signature.',
      retrievalContext: ['Cafeteria lunch menu rotations occur weekly.'],
    },
    judge,
    0.5,
  );
  assert.equal(noise.score, 0);
});

// ---- generator metrics -------------------------------------------------------

test('faithfulness: extractive answer over context scores 1.0', async () => {
  const ctx = ['validateSessionToken checks the session token signature before use.'];
  const answer = await extractiveGenerator()('What does validateSessionToken do?', ctx);
  const r = await faithfulness({ actualOutput: answer, retrievalContext: ctx }, judge, 0.5);
  assert.equal(r.score, 1);
  assert.equal(r.component, 'generator');
});

test('faithfulness: penalizes claims not grounded in context, even when plausible', async () => {
  const ctx = ['validateSessionToken checks the session token signature before use.'];
  const answer = await hallucinatingGenerator()('What does validateSessionToken do?', ctx);
  const r = await faithfulness({ actualOutput: answer, retrievalContext: ctx }, judge, 0.9);
  assert.ok(r.score < 1, 'injected parametric claim must lower faithfulness');
  assert.ok(!r.passed);
  assert.match(r.reason, /not grounded/);
});

test('answerRelevancy: direct answer reverse-engineers back to the question', async () => {
  const direct = await answerRelevancy(
    {
      input: 'What does validateSessionToken do?',
      actualOutput: 'validateSessionToken checks the session token signature.',
    },
    judge,
    0.3,
  );
  const evasive = await answerRelevancy(
    {
      input: 'What does validateSessionToken do?',
      actualOutput: 'Our cafeteria rotates its lunch menu weekly across four cuisines.',
    },
    judge,
    0.3,
  );
  assert.ok(direct.score > evasive.score, 'direct answer must outscore evasive answer');
  assert.ok(direct.passed);
  assert.ok(!evasive.passed);
});

// ---- judge + jury -------------------------------------------------------------

test('jury: strict majority vote across jurors (bias mitigation)', async () => {
  const yes: Judge = {
    name: 'always-yes',
    decomposeStatements: async (t) => [t],
    isAttributable: async () => true,
    isRelevant: async () => true,
    reverseEngineerQuestions: async (a) => [a],
  };
  const no: Judge = { ...yes, name: 'always-no', isAttributable: async () => false, isRelevant: async () => false };

  const jury21 = new JudgeJury([yes, yes, no]);
  assert.equal(await jury21.isAttributable('claim', ['ctx']), true);

  const jury12 = new JudgeJury([yes, no, no]);
  assert.equal(await jury12.isAttributable('claim', ['ctx']), false);

  // even split breaks toward NO — the conservative verdict
  const jury11 = new JudgeJury([yes, no]);
  assert.equal(await jury11.isAttributable('claim', ['ctx']), false);

  assert.throws(() => new JudgeJury([]));
});

// ---- synthetic golden pipeline -------------------------------------------------

const corpus: CorpusDoc[] = [
  {
    title: 'auth-service.ts',
    originFile: 'src/auth-service.ts',
    text: 'export function validateSessionToken(token) { return verifySignature(token); } The validateSessionToken helper rejects expired session credentials.',
  },
  {
    title: 'billing-service.ts',
    originFile: 'src/billing-service.ts',
    text: 'export function prorateRefund(invoice) { return invoice.total * remainingDays(); } The prorateRefund routine settles partial subscription charges.',
  },
  {
    title: 'storage-service.ts',
    originFile: 'src/storage-service.ts',
    text: 'export function verifyChecksum(blob) { return sha256(blob) === blob.manifestChecksum; } The verifyChecksum step guards multipart uploads.',
  },
];

test('critic: rejects dangling pronouns and fragments, accepts self-contained questions', () => {
  const good = critiqueInput('What does validateSessionToken do in auth-service.ts?');
  assert.ok(good.selfContainment >= 0.6 && good.clarity >= 0.6);

  const pronoun = critiqueInput('It does what exactly?');
  assert.ok(pronoun.selfContainment < 0.6, 'dangling pronoun must fail self-containment');

  const fragment = critiqueInput('token?');
  assert.ok(fragment.clarity < 0.6, 'fragment must fail clarity');
});

test('synthesizer: goldens are grounded, filtered, and deterministic per seed', () => {
  const a = synthesizeGoldens(corpus, { seed: 7, maxGoldens: 10 });
  const b = synthesizeGoldens(corpus, { seed: 7, maxGoldens: 10 });
  assert.ok(a.length > 0, 'corpus must yield goldens');
  assert.deepEqual(a, b, 'identical seed must synthesize the identical dataset');

  for (const g of a) {
    assert.match(g.input, /\?$/, 'styled input must be a question');
    assert.ok(g.expectedOutput.length > 0, 'expected output extracted from corpus');
    assert.ok(g.quality.selfContainment >= 0.6 && g.quality.clarity >= 0.6, 'filtration floor enforced');
    // grounded: the expected output must literally come from a source context
    assert.ok(
      g.sourceContexts.some((c) => g.expectedOutput.includes(c) || c.includes(g.expectedOutput)),
      'expected output must be rooted in its source context',
    );
  }
});

test('synthesizer: evolution produces multi-context goldens spanning documents', () => {
  // high evolution rate forces stage-3 mutations
  const goldens = synthesizeGoldens(corpus, { seed: 3, maxGoldens: 10, evolutionRate: 1 });
  const evolved = goldens.filter((g) => g.evolutions.length > 0);
  assert.ok(evolved.length > 0, 'evolutionRate=1 must evolve at least one golden');
  const multi = goldens.find((g) => g.evolutions.includes('multi-context'));
  if (multi) assert.ok(multi.sourceContexts.length >= 2, 'multi-context golden must span 2+ contexts');
});
