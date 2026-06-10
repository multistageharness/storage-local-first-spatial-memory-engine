/**
 * IDEA.v2 §7 — the connector source contract.
 *
 * Connectors stream content in; they never diff it (the shard kernel's
 * replaceDocument content_hash no-op is the diffing primitive) and never
 * write checkpoints themselves (the runner persists a yielded cursor
 * only AFTER the events preceding it have committed).
 */
import type { ClusterDef } from '../workers/protocol.js';
import type { ShardKind } from '../federation/catalog.js';

export interface SourceDocument {
  /** repo-relative path | confluence page id */
  sourceKey: string;
  title: string;
  /** code-macro bodies / code chunks byte-verbatim — the exact-match payload */
  text: string;
  /** sha256 hex of the text | git blob sha */
  contentHash: string;
  /** git blob sha | confluence version number */
  sourceVersion?: string;
  originFile?: string;
}

export interface ShardDescriptor {
  /** 'cf:<SPACEKEY>' | 'gh:<org>/<repo>' */
  shardKey: string;
  kind: ShardKind;
  displayName: string;
  /** routing scopes known at discovery time (may be refined mid-crawl) */
  clusters?: ClusterDef[];
}

/**
 * One step of a crawl stream. Events are processed strictly in order:
 *   - batch:    documents to upsert (replaceDocument each);
 *   - deletes:  sourceKeys removed at the source (deleteDocument each);
 *   - clusters: refined routing scopes discovered mid-crawl (page trees,
 *               top-level directories) — upserted into the catalog;
 *   - cursor:   a durable resume point. The runner persists it ONLY
 *               after every preceding event committed — a crash between
 *               commit and checkpoint re-ingests exactly one idempotent
 *               batch (content_hash no-op), never loses data (IDEA.v2 §12).
 */
export interface CrawlEvent {
  batch?: SourceDocument[];
  deletes?: string[];
  clusters?: ClusterDef[];
  cursor?: string;
}

export interface Connector {
  /** checkpoint namespace ('confluence' | 'git-org' | ...) */
  readonly name: string;
  /** enumerate source containers (spaces | repos) → shard descriptors */
  discoverShards(): AsyncIterable<ShardDescriptor>;
  /** complete crawl of one container; ends with a cursor event */
  fullCrawl(shard: ShardDescriptor): AsyncIterable<CrawlEvent>;
  /** incremental crawl from a previously persisted cursor */
  deltaCrawl(shard: ShardDescriptor, cursor: string): AsyncIterable<CrawlEvent>;
}
