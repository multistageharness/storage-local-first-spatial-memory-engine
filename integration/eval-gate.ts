/**
 * Eval gate — the CI deployment gate from the RAG Evaluation Harness guide,
 * run end-to-end against the live engine:
 *
 *   1. Generate a deterministic synthetic corpus (seeded — identical every
 *      run) and ingest it through the real chunk → route → FTS5 pipeline.
 *   2. Synthesize goldens via the four-stage pipeline (generate → critic
 *      filtration → evolution → styling). Goldens hold static inputs and
 *      expected outputs ONLY.
 *   3. Dynamically execute every golden: live FTS5 retrieval + extractive
 *      generation at the moment of evaluation — never pre-computed.
 *   4. Score the four component-isolated metrics against thresholds and
 *      emit a JSON report with per-component failure attribution.
 *
 * Exits non-zero when any golden fails any metric gate — wire it directly
 * into CI: `npm run eval`.
 *
 * Usage: node dist/examples/eval-gate.js [--goldens 16] [--seed 42]
 *        [--db path] [--report path] [--jury]
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MemoryEngine } from '../dist/src/engine.js';
import { synthesizeGoldens, type CorpusDoc } from '../__test__/eval/goldens.js';
import { RagEvalHarness, DEFAULT_THRESHOLDS } from '../__test__/eval/harness.js';
import { engineRetriever } from '../__test__/eval/retriever.js';
import { LexicalJudge, JudgeJury } from '../__test__/eval/judge.js';

// ---- CLI ----------------------------------------------------------------

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const GOLDENS = Number(arg('goldens', '16'));
const SEED = Number(arg('seed', '42'));
const DB_PATH = arg('db', join(process.cwd(), '.data', 'eval-gate.db'));
const REPORT_PATH = arg('report', join(process.cwd(), '.data', 'eval-report.json'));
const USE_JURY = process.argv.includes('--jury');

// ---- deterministic synthetic corpus ---------------------------------------

const DOMAINS = [
  {
    cluster: { name: 'auth', keywords: ['login', 'password', 'token', 'session', 'oauth', 'credential'] },
    nouns: ['Session', 'Token', 'Credential', 'Login', 'Password', 'Identity'],
    verbs: ['validate', 'issue', 'revoke', 'refresh', 'hash', 'authorize'],
  },
  {
    cluster: { name: 'billing', keywords: ['invoice', 'payment', 'stripe', 'charge', 'subscription', 'refund'] },
    nouns: ['Invoice', 'Payment', 'Charge', 'Subscription', 'Refund', 'Receipt'],
    verbs: ['calculate', 'process', 'capture', 'settle', 'prorate', 'reconcile'],
  },
  {
    cluster: { name: 'storage', keywords: ['bucket', 'blob', 'upload', 'download', 'multipart', 'checksum'] },
    nouns: ['Bucket', 'Blob', 'Upload', 'Manifest', 'Checksum', 'Object'],
    verbs: ['stream', 'persist', 'replicate', 'verify', 'compact', 'restore'],
  },
  {
    cluster: { name: 'networking', keywords: ['socket', 'request', 'response', 'retry', 'timeout', 'header'] },
    nouns: ['Socket', 'Request', 'Response', 'Header', 'Backoff', 'Route'],
    verbs: ['dispatch', 'negotiate', 'multiplex', 'throttle', 'resolve', 'proxy'],
  },
];

/** Each doc plants one unique identifier with a descriptive sentence — the
 *  extractable ground truth the synthesizer turns into goldens. */
function buildCorpus(count: number): CorpusDoc[] {
  const docs: CorpusDoc[] = [];
  for (let i = 0; i < count; i++) {
    const domain = DOMAINS[i % DOMAINS.length];
    const noun = domain.nouns[i % domain.nouns.length];
    const verb = domain.verbs[(i * 3) % domain.verbs.length];
    const identifier = `${verb}${noun}V${i}`;
    const keywords = domain.cluster.keywords;
    docs.push({
      title: `${domain.cluster.name}-module-${i}.ts`,
      originFile: `src/${domain.cluster.name}/${identifier}.ts`,
      text:
        `export function ${identifier}(payload) { return ${verb}(payload.${keywords[0]}); } ` +
        `The ${identifier} routine handles the ${keywords[i % keywords.length]} ${keywords[(i + 1) % keywords.length]} flow. ` +
        `It coordinates ${keywords[(i + 2) % keywords.length]} processing for the ${domain.cluster.name} subsystem.`,
    });
  }
  return docs;
}

// ---- the gate -------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  rmSync(DB_PATH, { force: true });
  rmSync(`${DB_PATH}-wal`, { force: true });
  rmSync(`${DB_PATH}-shm`, { force: true });

  const corpus = buildCorpus(GOLDENS * 2);
  console.log(`eval-gate: ${corpus.length} corpus docs, seed ${SEED}`);

  const engine = await MemoryEngine.open({
    dbPath: DB_PATH,
    graph: 'eval-gate',
    clusters: DOMAINS.map((d) => d.cluster),
    minReaders: 2,
  });

  try {
    for (const doc of corpus) await engine.ingestDocument(doc);

    // four-stage synthesis: generate → filter → evolve → style
    const goldens = synthesizeGoldens(corpus, { seed: SEED, maxGoldens: GOLDENS });
    console.log(`eval-gate: ${goldens.length} goldens synthesized (${goldens.filter((g) => g.evolutions.length > 0).length} evolved)`);

    const judge = USE_JURY
      ? new JudgeJury([
          new LexicalJudge({ attributionThreshold: 0.6 }),
          new LexicalJudge({ attributionThreshold: 0.7 }),
          new LexicalJudge({ attributionThreshold: 0.8 }),
        ])
      : new LexicalJudge();

    const harness = new RagEvalHarness({
      // dynamic execution: question → keywords → live FTS5 → RRF, at gate time
      retrieve: engineRetriever(engine, { limit: 5 }),
      judge,
    });

    const report = await harness.run(goldens);

    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`eval-gate: report written to ${REPORT_PATH}`);
    console.log(`eval-gate: judge = ${report.judge}`);
    console.log(`eval-gate: thresholds = ${JSON.stringify(DEFAULT_THRESHOLDS)}`);
    console.log(`eval-gate: metric means = ${JSON.stringify(report.metricMeans)}`);
    console.log(
      `eval-gate: ${report.totals.passed}/${report.totals.cases} cases passed ` +
        `(component failures: retriever=${report.componentFailures.retriever}, generator=${report.componentFailures.generator})`,
    );

    if (!report.passed) {
      for (const c of report.cases.filter((x) => !x.passed)) {
        for (const m of c.metrics.filter((x) => !x.passed)) {
          console.error(`  FAIL [${m.component}] ${m.name} ${m.score} < ${m.threshold} — "${c.input}" (${m.reason})`);
        }
      }
      console.error('eval-gate: GATE FAILED — deployment blocked');
      process.exitCode = 1;
      return;
    }
    console.log('eval-gate: GATE PASSED');
  } finally {
    await engine.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
