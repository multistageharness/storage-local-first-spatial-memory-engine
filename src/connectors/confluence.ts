/**
 * IDEA.v2 §7.1 — ConfluenceConnector: spaces → shards, Cloud v2 API.
 *
 *   - discoverShards: GET /wiki/api/v2/spaces (paginated); top-level
 *     page titles become the shard's ClusterDef routing scopes;
 *   - fullCrawl: pages with body-format=storage, batched; storage-format
 *     → text via storageToText (code macros byte-verbatim);
 *   - deltaCrawl: CQL `space=<key> and lastModified > <watermark>`
 *     ordered by lastModified; cursor = {watermark, pageCursor} so a
 *     mid-pagination crash resumes exactly; trashed-page sweep emits
 *     deletes;
 *   - token-bucket rate limiting (default 8 req/s), Retry-After honored
 *     with retries — 429 storms are survivable, not fatal.
 *
 * All tests/gates run against FixtureConfluenceServer (zero network in
 * CI); a real Confluence Cloud site is the same wire format behind a
 * --live flag.
 */
import { createHash } from 'node:crypto';
import { storageToText } from './confluence-storage.js';
import type { Connector, CrawlEvent, ShardDescriptor, SourceDocument } from './types.js';
import type { ClusterDef } from '../workers/protocol.js';

export interface ConfluenceConnectorOptions {
  /** e.g. https://yoursite.atlassian.net or the fixture server origin */
  baseUrl: string;
  /** PAT — sourced from the environment, never persisted (IDEA.v2 governance) */
  token?: string;
  batchSize?: number;
  ratePerSec?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  /** injectable clock (deterministic watermarks in tests) */
  now?: () => Date;
}

interface V2Space {
  id: string;
  key: string;
  name: string;
}

interface V2Page {
  id: string;
  title: string;
  parentId?: string | null;
  version?: { number: number };
  lastModified?: string;
  body?: { storage?: { value: string } };
}

interface Paged<T> {
  results: T[];
  _links?: { next?: string };
}

/** simple token bucket: `rate` tokens/s, burst = rate */
class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(private readonly rate: number) {
    this.tokens = rate;
  }
  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = ((1 - this.tokens) / this.rate) * 1000;
      await new Promise((r) => setTimeout(r, Math.max(1, waitMs)));
    }
  }
}

export class ConfluenceConnector implements Connector {
  readonly name = 'confluence';
  private readonly bucket: TokenBucket;
  private readonly fetchImpl: typeof fetch;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly now: () => Date;
  /** telemetry: requests issued / 429s absorbed (asserted by tests) */
  requests = 0;
  rateLimited = 0;

  constructor(private readonly opts: ConfluenceConnectorOptions) {
    this.bucket = new TokenBucket(opts.ratePerSec ?? 8);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.batchSize = opts.batchSize ?? 50;
    this.maxRetries = opts.maxRetries ?? 5;
    this.now = opts.now ?? (() => new Date());
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.opts.baseUrl}${path}`;
    for (let attempt = 0; ; attempt++) {
      await this.bucket.take();
      this.requests++;
      const res = await this.fetchImpl(url, {
        headers: this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {},
      });
      if (res.status === 429) {
        this.rateLimited++;
        if (attempt >= this.maxRetries) throw new Error(`confluence: 429 storm exceeded ${this.maxRetries} retries`);
        const retryAfter = Number(res.headers.get('retry-after') ?? '1');
        await new Promise((r) => setTimeout(r, Math.max(10, retryAfter * 1000)));
        continue;
      }
      if (!res.ok) throw new Error(`confluence: HTTP ${res.status} for ${path}`);
      return (await res.json()) as T;
    }
  }

  private async *paginate<T>(firstPath: string): AsyncGenerator<{ results: T[]; nextCursor: string | null }> {
    let path: string | null = firstPath;
    while (path) {
      const page: Paged<T> = await this.get<Paged<T>>(path);
      const next: string | null = page._links?.next ?? null;
      yield { results: page.results, nextCursor: next ? new URL(next, 'http://x').searchParams.get('cursor') : null };
      path = next;
    }
  }

  private toDocument(page: V2Page): SourceDocument {
    const text = storageToText(page.body?.storage?.value ?? '');
    return {
      sourceKey: page.id,
      title: page.title,
      text,
      contentHash: createHash('sha256').update(text).digest('hex'),
      sourceVersion: page.version ? String(page.version.number) : undefined,
      originFile: page.title,
    };
  }

  private async spaceByKey(key: string): Promise<V2Space> {
    const res = await this.get<Paged<V2Space>>(`/wiki/api/v2/spaces?keys=${encodeURIComponent(key)}`);
    if (res.results.length === 0) throw new Error(`confluence: unknown space ${key}`);
    return res.results[0];
  }

  async *discoverShards(): AsyncIterable<ShardDescriptor> {
    for await (const { results } of this.paginate<V2Space>(`/wiki/api/v2/spaces?limit=25`)) {
      for (const space of results) {
        // page-tree top-level names → cluster routing scopes (DEMO001 §4.2)
        const top = await this.get<Paged<V2Page>>(
          `/wiki/api/v2/spaces/${space.id}/pages?depth=root&limit=${this.batchSize}`,
        );
        const clusters: ClusterDef[] = top.results.map((p) => ({
          name: p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'page',
          keywords: p.title.split(/\s+/).filter((w) => w.length >= 3),
        }));
        yield { shardKey: `cf:${space.key}`, kind: 'space', displayName: space.name, clusters };
      }
    }
  }

  async *fullCrawl(shard: ShardDescriptor): AsyncIterable<CrawlEvent> {
    const key = shard.shardKey.replace(/^cf:/, '');
    const space = await this.spaceByKey(key);
    // watermark captured BEFORE the crawl: edits landing mid-crawl are
    // re-seen by the next delta (at-least-once, hash-skip dedupes)
    const watermark = this.now().toISOString();
    for await (const { results } of this.paginate<V2Page>(
      `/wiki/api/v2/spaces/${space.id}/pages?body-format=storage&limit=${this.batchSize}`,
    )) {
      if (results.length > 0) yield { batch: results.map((p) => this.toDocument(p)) };
    }
    yield { cursor: JSON.stringify({ watermark, pageCursor: null }) };
  }

  async *deltaCrawl(shard: ShardDescriptor, cursor: string): AsyncIterable<CrawlEvent> {
    const key = shard.shardKey.replace(/^cf:/, '');
    const space = await this.spaceByKey(key);
    const { watermark, pageCursor } = JSON.parse(cursor) as { watermark: string; pageCursor: string | null };
    const newWatermark = this.now().toISOString();

    const cql = encodeURIComponent(`space=${key} and lastModified > ${watermark}`);
    let path: string | null = `/wiki/rest/api/search?cql=${cql}&limit=${this.batchSize}${
      pageCursor ? `&cursor=${encodeURIComponent(pageCursor)}` : ''
    }`;
    while (path) {
      const page: Paged<V2Page> = await this.get<Paged<V2Page>>(path);
      const next: string | null = page._links?.next ?? null;
      if (page.results.length > 0) {
        const nextCursor = next ? new URL(next, 'http://x').searchParams.get('cursor') : null;
        yield {
          batch: page.results.map((p) => this.toDocument(p)),
          // mid-pagination durable resume point: same watermark, advanced page cursor
          cursor: JSON.stringify(
            nextCursor ? { watermark, pageCursor: nextCursor } : { watermark: newWatermark, pageCursor: null },
          ),
        };
      }
      path = next;
    }

    // trashed-page sweep → deletions (FTS trigger hygiene on both indexes)
    const trashed: string[] = [];
    for await (const { results } of this.paginate<V2Page>(
      `/wiki/api/v2/spaces/${space.id}/pages?status=trashed&limit=${this.batchSize}`,
    )) {
      trashed.push(...results.map((p) => p.id));
    }
    if (trashed.length > 0) yield { deletes: trashed };
    yield { cursor: JSON.stringify({ watermark: newWatermark, pageCursor: null }) };
  }
}
