/**
 * IDEA.v2 §10.4 — federated benchmark datasets.
 *
 *   - org-synthetic-v2: generated over the synthetic org; five bands
 *     (55/25/10/10 + cross-shard [0.1, 0.2]); near-collision lures are
 *     the distractors; docIds carry shard attribution
 *     (`${shardKey}:${originFile}`);
 *   - confluence-fixture-v2: deterministic curated cases over the
 *     recorded fixture site (3 spaces; code macros, tables, prose);
 *     distractors = sibling spaces with overlapping vocabulary;
 *   - repo-org-v2: demo001's repo auto-annotator run PER SHARD over a
 *     fixture org, merged with shard attribution. The intrinsic critic
 *     stays retrieval-blind (IDEA.v2 §12 — routing ground truth comes
 *     from the generator, never the router under test).
 */
import type { BenchmarkCase, BenchmarkDataset } from '../eval/benchmark.js';
import type { CorpusDoc } from '../eval/goldens.js';
import { buildRepoBenchmark } from './repo-loader.js';
import { storageToText } from '../../src/connectors/confluence-storage.js';
import { mulberry32, type SyntheticOrg } from './org-dataset.js';
import type { FixtureSpace } from '../fixtures/confluence-fixture-server.js';

const docId = (shardKey: string, originFile: string) => `${shardKey}:${originFile}`;

// ---- org-synthetic-v2 -------------------------------------------------------

export function buildOrgSyntheticDataset(org: SyntheticOrg, opts: { seed?: number } = {}): BenchmarkDataset {
  const rnd = mulberry32(opts.seed ?? 0xda7a);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const cases: BenchmarkCase[] = [];
  const corpus: CorpusDoc[] = org.shards.flatMap((s) =>
    s.docs.map((d) => ({ title: docId(s.shardKey, d.originFile!), text: d.text, originFile: d.originFile })),
  );

  const usedDocs = new Set<string>();
  const pickDoc = () => {
    for (let tries = 0; tries < 50; tries++) {
      const shard = pick(org.shards);
      const doc = pick(shard.docs);
      const key = docId(shard.shardKey, doc.originFile!);
      if (!usedDocs.has(key)) {
        usedDocs.add(key);
        return { shard, doc, key };
      }
    }
    const shard = pick(org.shards);
    const doc = pick(shard.docs);
    return { shard, doc, key: docId(shard.shardKey, doc.originFile!) };
  };
  const needleAnswer = (needle: string) => `export function ${needle}(items: LineItem[]): number {`;

  // 20 common (50%) — direct needle lookups
  for (let i = 0; i < 20; i++) {
    const { shard, doc, key } = pickDoc();
    cases.push({
      id: `org-common-${i}`,
      input: `What does ${doc.needle} compute?`,
      expectedAnswer: needleAnswer(doc.needle),
      supportingDocs: [key],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'free' },
    });
  }
  // 7 distractor (17.5%) — near-collision lures share verb+noun across shards
  for (let i = 0; i < 7; i++) {
    const { shard, doc, key } = pickDoc();
    cases.push({
      id: `org-distractor-${i}`,
      input: `Where is ${doc.needle} implemented?`,
      expectedAnswer: needleAnswer(doc.needle),
      supportingDocs: [key],
      metadata: {
        answerable: true,
        queryType: 'distractor',
        difficulty: 'medium',
        allowedVariance: 'free',
        tags: ['near-collision-lure'],
      },
    });
  }
  // 4 multi-hop (10%) — two needles from ONE shard
  for (let i = 0; i < 4; i++) {
    const shard = pick(org.shards);
    const a = shard.docs[Math.floor(rnd() * shard.docs.length)];
    let b = shard.docs[Math.floor(rnd() * shard.docs.length)];
    for (let t = 0; b.sourceKey === a.sourceKey && t < 10; t++) b = shard.docs[Math.floor(rnd() * shard.docs.length)];
    cases.push({
      id: `org-multihop-${i}`,
      input: `What do ${a.needle} and ${b.needle} compute?`,
      expectedAnswer: `${needleAnswer(a.needle)} ${needleAnswer(b.needle)}`,
      supportingDocs: [docId(shard.shardKey, a.originFile!), docId(shard.shardKey, b.originFile!)],
      metadata: { answerable: true, queryType: 'multi-hop', difficulty: 'hard', allowedVariance: 'free' },
    });
  }
  // 5 cross-shard (12.5%) — supporting docs span two shards
  for (let i = 0; i < 5; i++) {
    const a = pickDoc();
    let b = pickDoc();
    for (let t = 0; b.shard.shardKey === a.shard.shardKey && t < 10; t++) b = pickDoc();
    cases.push({
      id: `org-crossshard-${i}`,
      input: `What do ${a.doc.needle} and ${b.doc.needle} compute?`,
      expectedAnswer: `${needleAnswer(a.doc.needle)} ${needleAnswer(b.doc.needle)}`,
      supportingDocs: [a.key, b.key],
      metadata: { answerable: true, queryType: 'cross-shard', difficulty: 'hard', allowedVariance: 'free' },
    });
  }
  // 4 no-answer (10%) — verified-absent identifiers
  for (let i = 0; i < 4; i++) {
    cases.push({
      id: `org-noanswer-${i}`,
      input: `What does phantomZxq${Math.floor(rnd() * 1e6).toString(36)}Quux do?`,
      expectedAnswer: '',
      supportingDocs: [],
      metadata: { answerable: false, queryType: 'no-answer', difficulty: 'medium', allowedVariance: 'free' },
    });
  }

  return {
    name: 'org-synthetic-v2',
    provenance: { curatedBy: 'org-dataset generator (seeded)' },
    corpus,
    cases,
  };
}

// ---- confluence-fixture-v2 -----------------------------------------------------

/**
 * Deterministic curated cases over the fixture site. The fixture content
 * is hand-authored; case synthesis just references its known structure.
 */
export function buildConfluenceFixtureDataset(site: FixtureSpace[]): BenchmarkDataset {
  const spaceKeyOf = (key: string) => `cf:${key}`;
  const corpus: CorpusDoc[] = site.flatMap((s) =>
    s.pages.map((p) => ({ title: docId(spaceKeyOf(s.key), p.title), text: storageToText(p.body), originFile: p.title })),
  );
  const pageTitle = (spaceIdx: number, topicIdx: number, i: number, site_: FixtureSpace[]): string => {
    // children carry "<topic> — note <i>" titles; resolve via the fixture
    const space = site_[spaceIdx];
    const roots = space.pages.filter((p) => p.parentId == null);
    return `${roots[topicIdx].title} — note ${i}`;
  };

  const cases: BenchmarkCase[] = [];
  // 11 common — code-macro tokens + table cells + prose, across all 3 spaces
  const commons: [string, string, string, string][] = [
    // [input, expectedAnswer fragment, space, page title]
    [`What does engHelper_1003 return?`, `export function engHelper_1003(cfg: Config)`, 'cf:ENG', pageTitle(0, 0, 3, site)],
    [`What does engHelper_1105 return?`, `export function engHelper_1105(cfg: Config)`, 'cf:ENG', pageTitle(0, 1, 5, site)],
    [`What does engHelper_1207 return?`, `export function engHelper_1207(cfg: Config)`, 'cf:ENG', pageTitle(0, 2, 7, site)],
    [`Which owner is listed for svc-1002?`, `svc-1002 | team-2`, 'cf:ENG', pageTitle(0, 0, 2, site)],
    [`Which owner is listed for svc-1104?`, `svc-1104 | team-4`, 'cf:ENG', pageTitle(0, 1, 4, site)],
    [`Which quarter is milestone ms-2003 planned for?`, `ms-2003 | Q4`, 'cf:PROD', pageTitle(1, 0, 3, site)],
    [`Which quarter is milestone ms-2106 planned for?`, `ms-2106 | Q3`, 'cf:PROD', pageTitle(1, 1, 6, site)],
    // extractive ground truth = the line naming the identifier (the
    // generator extracts by query-term overlap, so the rule header line
    // is the answerable unit, not its inner fields)
    [`Which page defines audit rule rule_3001?`, `audit_rule "rule_3001" {`, 'cf:SEC', pageTitle(2, 0, 1, site)],
    [`Which page defines audit rule rule_3104?`, `audit_rule "rule_3104" {`, 'cf:SEC', pageTitle(2, 1, 4, site)],
    [`Where does spec-2002 link to?`, `Spec 2002 (https://docs.example/spec-2002)`, 'cf:PROD', pageTitle(1, 0, 2, site)],
    [`Where does runbook-1001 link to?`, `Runbook 1001 (https://wiki.example/runbook-1001)`, 'cf:ENG', pageTitle(0, 0, 1, site)],
  ];
  commons.forEach(([input, expected, shard, title], i) => {
    cases.push({
      id: `cf-common-${i}`,
      input,
      expectedAnswer: expected,
      supportingDocs: [docId(shard, title)],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'free' },
    });
  });
  // 5 distractor — sibling spaces share vocabulary ("note", "guidance",
  // operational prose); the unique token disambiguates
  const distractors: [string, string, string, string][] = [
    [`Which page documents secToken_3208?`, `match    = "secToken_3208"`, 'cf:SEC', pageTitle(2, 2, 8, site)],
    [`Which service row mentions svc-1206?`, `svc-1206 | team-6`, 'cf:ENG', pageTitle(0, 2, 6, site)],
    [`Which milestone row mentions ms-2209?`, `ms-2209 | Q2`, 'cf:PROD', pageTitle(1, 2, 9, site)],
    [`What does engHelper_1110 return?`, `export function engHelper_1110(cfg: Config)`, 'cf:ENG', pageTitle(0, 1, 10, site)],
    [`What does rule_3010 match?`, `match    = "secToken_3010"`, 'cf:SEC', pageTitle(2, 0, 10, site)],
  ];
  distractors.forEach(([input, expected, shard, title], i) => {
    cases.push({
      id: `cf-distractor-${i}`,
      input,
      expectedAnswer: expected,
      supportingDocs: [docId(shard, title)],
      metadata: { answerable: true, queryType: 'distractor', difficulty: 'medium', allowedVariance: 'free', tags: ['sibling-space-vocabulary'] },
    });
  });
  // 2 multi-hop — two pages of one space
  cases.push({
    id: `cf-multihop-0`,
    input: `What do engHelper_1004 and engHelper_1006 return?`,
    expectedAnswer: `export function engHelper_1004(cfg: Config) export function engHelper_1006(cfg: Config)`,
    supportingDocs: [docId('cf:ENG', pageTitle(0, 0, 4, site)), docId('cf:ENG', pageTitle(0, 0, 6, site))],
    metadata: { answerable: true, queryType: 'multi-hop', difficulty: 'hard', allowedVariance: 'free' },
  });
  cases.push({
    id: `cf-multihop-1`,
    input: `What do audit rules rule_3102 and rule_3106 match?`,
    expectedAnswer: `match    = "secToken_3102" match    = "secToken_3106"`,
    supportingDocs: [docId('cf:SEC', pageTitle(2, 1, 2, site)), docId('cf:SEC', pageTitle(2, 1, 6, site))],
    metadata: { answerable: true, queryType: 'multi-hop', difficulty: 'hard', allowedVariance: 'free' },
  });
  // 2 no-answer — queries carry ONLY absent identifiers + stopwords, so
  // refusal is the single correct behavior (no content-word bycatch)
  cases.push({
    id: `cf-noanswer-0`,
    input: `What does engHelper_9999 do?`,
    expectedAnswer: '',
    supportingDocs: [],
    metadata: { answerable: false, queryType: 'no-answer', difficulty: 'medium', allowedVariance: 'free' },
  });
  cases.push({
    id: `cf-noanswer-1`,
    input: `What is ms-7777?`,
    expectedAnswer: '',
    supportingDocs: [],
    metadata: { answerable: false, queryType: 'no-answer', difficulty: 'medium', allowedVariance: 'free' },
  });

  return {
    name: 'confluence-fixture-v2',
    provenance: { curatedBy: 'hand-curated over the recorded fixture site' },
    corpus,
    cases,
  };
}

// ---- repo-org-v2 ------------------------------------------------------------------

export interface RepoShardCorpus {
  shardKey: string;
  corpus: CorpusDoc[];
}

/**
 * demo001's auto-annotator run per shard, merged with shard attribution:
 * `supportingDocs` ids become `${shardKey}:${path}` (extends §9.4's
 * "repo-relative path = doc id"). The intrinsic critic inside
 * buildRepoBenchmark is retrieval-blind by design and survives
 * federation unchanged.
 */
export function buildRepoOrgDataset(
  shards: RepoShardCorpus[],
  opts: { seed?: number; casesPerShard?: number } = {},
): BenchmarkDataset {
  const seed = opts.seed ?? 7;
  const casesPerShard = opts.casesPerShard ?? 8;
  const mergedCases: BenchmarkCase[] = [];
  const mergedCorpus: CorpusDoc[] = [];

  for (const shard of shards) {
    const ds = buildRepoBenchmark(shard.corpus, {
      seed,
      totalCases: casesPerShard,
      name: `repo-${shard.shardKey}`,
    });
    for (const doc of ds.corpus) {
      mergedCorpus.push({ ...doc, title: docId(shard.shardKey, doc.originFile ?? doc.title) });
    }
    for (const c of ds.cases) {
      mergedCases.push({
        ...c,
        id: `${shard.shardKey}:${c.id}`,
        supportingDocs: c.supportingDocs.map((d) => docId(shard.shardKey, d)),
        metadata: { ...c.metadata, tags: [...(c.metadata.tags ?? []), shard.shardKey] },
      });
    }
  }

  return {
    name: 'repo-org-v2',
    provenance: { curatedBy: 'repo auto-annotator (per shard, merged)' },
    corpus: mergedCorpus,
    cases: mergedCases,
  };
}
