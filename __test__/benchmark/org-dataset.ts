/**
 * IDEA.v2 §10.1 — synthetic org generator.
 *
 * Extends demo001's rag-at-scale corpus generator (seeded mulberry32
 * domains, planted needles) to a fleet:
 *
 *   - per-shard unique codename (e.g. CrimsonFalcon12) woven through
 *     every document — the organic routing signal that the catalog's
 *     tf×idf recompute should surface as a routing term;
 *   - per-shard unique needles `${verb}${Noun}${Codename}x${docIdx}`
 *     with cross-shard near-collision lures (same verb+noun, different
 *     codename/index — federation's organic distractors);
 *   - per-shard routing-term ground truth for router-recall gating.
 *
 * Deterministic: same seed ⇒ identical org (DEMO001 §8.3 guarantee).
 */
import type { ClusterDef } from '../../src/workers/protocol.js';
import type { SourceDocumentInput } from '../../src/engine.js';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const ORG_DOMAINS = [
  {
    name: 'auth',
    keywords: ['login', 'password', 'token', 'session', 'oauth', 'credential'],
    nouns: ['Session', 'Token', 'Credential', 'Login', 'Password', 'Identity'],
    verbs: ['validate', 'issue', 'revoke', 'refresh', 'hash', 'authorize'],
  },
  {
    name: 'billing',
    keywords: ['invoice', 'payment', 'stripe', 'charge', 'subscription', 'refund'],
    nouns: ['Invoice', 'Payment', 'Charge', 'Subscription', 'Refund', 'Receipt'],
    verbs: ['calculate', 'process', 'capture', 'settle', 'prorate', 'reconcile'],
  },
  {
    name: 'storage',
    keywords: ['bucket', 'blob', 'upload', 'download', 'multipart', 'checksum'],
    nouns: ['Bucket', 'Blob', 'Upload', 'Manifest', 'Checksum', 'Object'],
    verbs: ['stream', 'persist', 'replicate', 'verify', 'compact', 'restore'],
  },
  {
    name: 'networking',
    keywords: ['socket', 'request', 'response', 'retry', 'timeout', 'header'],
    nouns: ['Socket', 'Request', 'Response', 'Header', 'Backoff', 'Route'],
    verbs: ['dispatch', 'negotiate', 'multiplex', 'throttle', 'resolve', 'proxy'],
  },
  {
    name: 'search',
    keywords: ['index', 'query', 'ranking', 'tokenizer', 'snippet', 'relevance'],
    nouns: ['Index', 'Query', 'Ranking', 'Tokenizer', 'Snippet', 'Posting'],
    verbs: ['tokenize', 'rank', 'merge', 'highlight', 'score', 'rewrite'],
  },
  {
    name: 'ui',
    keywords: ['component', 'render', 'props', 'layout', 'theme', 'widget'],
    nouns: ['Component', 'Layout', 'Theme', 'Widget', 'Panel', 'Toolbar'],
    verbs: ['render', 'hydrate', 'memoize', 'animate', 'compose', 'mount'],
  },
] as const;

const COLORS = [
  'Crimson', 'Teal', 'Amber', 'Cobalt', 'Sage', 'Coral', 'Indigo', 'Slate',
  'Maroon', 'Olive', 'Plum', 'Rust', 'Azure', 'Fawn', 'Jade', 'Onyx',
];
const ANIMALS = [
  'Falcon', 'Otter', 'Lynx', 'Heron', 'Badger', 'Viper', 'Stork', 'Marten',
  'Osprey', 'Gecko', 'Bison', 'Crane', 'Dingo', 'Eland', 'Ferret', 'Gibbon',
];

export interface OrgDoc extends SourceDocumentInput {
  domain: string;
  /** planted ground-truth identifier, e.g. calculateInvoiceCrimsonFalcon12x003 */
  needle: string;
  /** camelCase suffix query used to find it, e.g. InvoiceCrimsonFalcon12x003 */
  needleQuery: string;
}

export interface OrgShardSpec {
  shardKey: string;
  displayName: string;
  /** unique per-shard codename woven through every doc */
  codename: string;
  clusters: ClusterDef[];
  /** ground-truth distinctive terms (codename + domain keywords) */
  routingTerms: string[];
  docs: OrgDoc[];
  /** expected atom count is computed by the gate via chunkText */
}

export interface SyntheticOrg {
  seed: number;
  shards: OrgShardSpec[];
}

export interface OrgOptions {
  seed?: number;
  shards?: number;
  docsPerShard?: number;
  domainsPerShard?: number;
}

function pick<T>(rnd: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rnd() * xs.length)];
}

function generateOrgDoc(
  rnd: () => number,
  shard: { codename: string; domains: (typeof ORG_DOMAINS)[number][] },
  docIdx: number,
): OrgDoc {
  const domain = shard.domains[docIdx % shard.domains.length];
  const id = String(docIdx).padStart(3, '0');
  const noun = pick(rnd, domain.nouns);
  const verb = pick(rnd, domain.verbs);
  const code = shard.codename;
  const codeLower = code.toLowerCase();
  // near-collision by construction: other shards reuse the same
  // verb+noun pools — only codename + index differ
  const needle = `${verb}${noun}${code}x${id}`;
  const needleQuery = `${noun}${code}x${id}`;

  const fns: string[] = [
    `// Project ${code} — ${domain.name} module ${id}`,
    `import { ${codeLower}Config } from '../${codeLower}/config.js';`,
  ];
  const fnCount = 2 + Math.floor(rnd() * 3);
  for (let f = 0; f < fnCount; f++) {
    const v = pick(rnd, domain.verbs);
    const n = pick(rnd, domain.nouns);
    const kw1 = pick(rnd, domain.keywords);
    const kw2 = pick(rnd, domain.keywords);
    fns.push(
      [
        `/** ${v}s the ${kw1} for the ${code} ${kw2} pipeline. */`,
        `export async function ${v}${n}${f}(input: ${n}Input): Promise<${n}Result> {`,
        `  const ${kw1}State = await load${n}State(${codeLower}Config, input.${kw2}Id);`,
        `  if (!${kw1}State.valid) throw new ${n}Error('invalid ${kw1} state in ${code}');`,
        `  return ${v}Core(${kw1}State, input.options ?? default${n}Options);`,
        `}`,
      ].join('\n'),
    );
  }
  const needleFn = [
    `/** Ground-truth needle for federated retrieval evaluation. */`,
    `export function ${needle}(items: LineItem[]): number {`,
    `  return items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0);`,
    `}`,
  ].join('\n');
  fns.splice(1 + Math.floor((fns.length - 1) / 2), 0, needleFn);

  const text = fns.join('\n\n');
  return {
    sourceKey: `src/${domain.name}/${verb}${noun}${id}.ts`,
    title: `${domain.name}/${verb}${noun}${id}.ts`,
    text,
    originFile: `src/${domain.name}/${verb}${noun}${id}.ts`,
    domain: domain.name,
    needle,
    needleQuery,
  };
}

export function buildSyntheticOrg(opts: OrgOptions = {}): SyntheticOrg {
  const seed = opts.seed ?? 42;
  const shardCount = opts.shards ?? 500;
  const docsPerShard = opts.docsPerShard ?? 40;
  const domainsPerShard = opts.domainsPerShard ?? 3;
  const rnd = mulberry32(seed);

  const shards: OrgShardSpec[] = [];
  for (let s = 0; s < shardCount; s++) {
    // codename unique by construction: color×animal cycle + shard index
    const codename = `${COLORS[s % COLORS.length]}${ANIMALS[Math.floor(s / COLORS.length) % ANIMALS.length]}${s}`;
    const domainStart = Math.floor(rnd() * ORG_DOMAINS.length);
    const domains = Array.from(
      { length: Math.min(domainsPerShard, ORG_DOMAINS.length) },
      (_, i) => ORG_DOMAINS[(domainStart + i) % ORG_DOMAINS.length],
    );
    const docRnd = mulberry32(seed ^ (s * 0x9e3779b9));
    const spec: OrgShardSpec = {
      shardKey: `syn:org-${s}`,
      displayName: `org shard ${s} (${codename})`,
      codename,
      clusters: domains.map((d) => ({ name: d.name, keywords: [...d.keywords] })),
      routingTerms: [codename.toLowerCase(), ...domains.flatMap((d) => d.keywords.slice(0, 2))],
      docs: Array.from({ length: docsPerShard }, (_, d) => generateOrgDoc(docRnd, { codename, domains }, d)),
    };
    shards.push(spec);
  }
  return { seed, shards };
}

// ---- query synthesis for the gates ---------------------------------------

export interface OrgQuery {
  type: 'needle' | 'cross-shard' | 'no-answer';
  query: string;
  /** shards expected to supply supporting atoms */
  expectedShards: string[];
  /** originFiles whose atoms count as ground truth, by shard */
  expectedDocs: { shardKey: string; originFile: string }[];
}

/** 70% in-shard needles / 20% cross-shard / 10% no-answer (IDEA.v2 §9.2). */
export function synthesizeOrgQueries(org: SyntheticOrg, count: number, seed = 0xbeef): OrgQuery[] {
  const rnd = mulberry32(seed);
  const queries: OrgQuery[] = [];
  const pickDoc = (): { shard: OrgShardSpec; doc: OrgDoc } => {
    const shard = org.shards[Math.floor(rnd() * org.shards.length)];
    const doc = shard.docs[Math.floor(rnd() * shard.docs.length)];
    return { shard, doc };
  };
  for (let i = 0; i < count; i++) {
    const r = rnd();
    if (r < 0.7) {
      const { shard, doc } = pickDoc();
      queries.push({
        type: 'needle',
        query: doc.needleQuery,
        expectedShards: [shard.shardKey],
        expectedDocs: [{ shardKey: shard.shardKey, originFile: doc.originFile! }],
      });
    } else if (r < 0.9 && org.shards.length >= 2) {
      let a = pickDoc();
      let b = pickDoc();
      for (let tries = 0; b.shard.shardKey === a.shard.shardKey && tries < 10; tries++) b = pickDoc();
      if (b.shard.shardKey === a.shard.shardKey) {
        i--;
        continue;
      }
      queries.push({
        type: 'cross-shard',
        query: `${a.doc.needleQuery} ${b.doc.needleQuery}`,
        expectedShards: [a.shard.shardKey, b.shard.shardKey],
        expectedDocs: [
          { shardKey: a.shard.shardKey, originFile: a.doc.originFile! },
          { shardKey: b.shard.shardKey, originFile: b.doc.originFile! },
        ],
      });
    } else {
      const n = Math.floor(rnd() * 1e9).toString(36);
      queries.push({
        type: 'no-answer',
        query: `Zxq${n}Phantom${Math.floor(rnd() * 999)}`,
        expectedShards: [],
        expectedDocs: [],
      });
    }
  }
  return queries;
}
