/**
 * IDEA.v2 §7 — the crawl runner: drives a Connector's event stream into
 * one shard with the checkpoint-after-commit discipline.
 *
 * Event processing is strictly sequential, so by the time a cursor
 * event is reached every preceding batch/delete has already committed
 * inside the shard's BEGIN IMMEDIATE transactions — persisting the
 * cursor then is what makes a crash re-ingest one idempotent batch
 * rather than lose data ("Checkpoint after commit, never before",
 * IDEA.v2 §12). For the same reason the runner does NOT route documents
 * through the scheduler's prefetch buffer: read-ahead would let a
 * cursor arrive before its batches were written.
 */
import { statSync } from 'node:fs';
import type { FederatedEngine } from '../federated-engine.js';
import { accumulateTerms } from '../federation/scheduler.js';
import type { Connector, CrawlEvent, ShardDescriptor } from './types.js';

export interface CrawlReport {
  shardKey: string;
  mode: 'full' | 'delta';
  docs: number;
  atoms: number;
  skippedDocs: number;
  deletedDocs: number;
  cursor: string | null;
  ms: number;
}

export interface RunCrawlOptions {
  /** 'auto' (default): delta when a checkpoint exists, else full */
  mode?: 'full' | 'delta' | 'auto';
  /** test hook: throw after N batch commits, BEFORE the next checkpoint
   *  write — simulates the crash window the discipline protects */
  crashAfterBatches?: number;
}

export async function runCrawl(
  org: FederatedEngine,
  connector: Connector,
  shard: ShardDescriptor,
  opts: RunCrawlOptions = {},
): Promise<CrawlReport> {
  const started = Date.now();
  const row = await org.ensureShard({
    shardKey: shard.shardKey,
    kind: shard.kind,
    displayName: shard.displayName,
    clusters: shard.clusters,
  });

  const prior = org.catalog.getCheckpoint(shard.shardKey, connector.name);
  const mode: 'full' | 'delta' = opts.mode === 'auto' || opts.mode == null ? (prior ? 'delta' : 'full') : opts.mode;
  const events: AsyncIterable<CrawlEvent> =
    mode === 'delta' && prior != null ? connector.deltaCrawl(shard, prior) : connector.fullCrawl(shard);

  org.catalog.setShardStatus(shard.shardKey, 'INGESTING');
  const termFreqs = new Map<string, number>();
  let docs = 0;
  let atoms = 0;
  let skipped = 0;
  let deleted = 0;
  let batchesCommitted = 0;
  let lastCursor: string | null = null;

  try {
    await org.withEngine(shard.shardKey, async (engine) => {
      for await (const event of events) {
        if (event.batch) {
          for (const doc of event.batch) {
            const res = await engine.replaceDocument(doc);
            docs++;
            if (res.skipped) skipped++;
            else {
              atoms += res.nodeIds.length;
              accumulateTerms(termFreqs, `${doc.title} ${doc.text}`);
            }
          }
          batchesCommitted++;
          if (opts.crashAfterBatches != null && batchesCommitted >= opts.crashAfterBatches) {
            throw new Error(`__crash-injection__ after ${batchesCommitted} committed batches`);
          }
        }
        if (event.deletes) {
          for (const key of event.deletes) {
            const res = await engine.deleteDocument(key);
            if (res.deleted) deleted++;
          }
        }
        if (event.clusters && event.clusters.length > 0) {
          await org.ensureShard({
            shardKey: shard.shardKey,
            kind: shard.kind,
            displayName: shard.displayName,
            clusters: event.clusters,
          });
        }
        if (event.cursor != null) {
          // every preceding event has committed — durable resume point
          org.catalog.putCheckpoint(shard.shardKey, connector.name, event.cursor);
          lastCursor = event.cursor;
        }
      }

      // post-ingest rollup: stats + split signal + routing signature
      const stats = await engine.stats();
      let bytes = 0;
      try {
        bytes = statSync(row.dbPath).size;
      } catch {
        /* empty shard */
      }
      org.catalog.updateShardStats(shard.shardKey, {
        atomCount: stats.nodes as number,
        docCount: stats.documents as number,
        bytes,
      });
      if (termFreqs.size > 0) org.catalog.recomputeRoutingTerms(shard.shardKey, termFreqs);
    });
    if (org.catalog.getShard(shard.shardKey)!.status !== 'SPLIT') {
      org.catalog.setShardStatus(shard.shardKey, 'ACTIVE');
    }
  } catch (err) {
    org.catalog.setShardStatus(shard.shardKey, 'ACTIVE');
    throw err;
  }

  return {
    shardKey: shard.shardKey,
    mode,
    docs,
    atoms,
    skippedDocs: skipped,
    deletedDocs: deleted,
    cursor: lastCursor ?? prior,
    ms: Date.now() - started,
  };
}

/**
 * Discover + crawl an entire source through the persistent queue:
 * enqueue one task per shard, then drain with the scheduler's bounded
 * workers (per-shard serialization included).
 */
export async function runOrgCrawl(
  org: FederatedEngine,
  connector: Connector,
  opts: { mode?: 'full' | 'delta' | 'auto' } = {},
): Promise<CrawlReport[]> {
  const descriptors = new Map<string, ShardDescriptor>();
  for await (const d of connector.discoverShards()) {
    descriptors.set(d.shardKey, d);
    await org.ensureShard({
      shardKey: d.shardKey,
      kind: d.kind,
      displayName: d.displayName,
      clusters: d.clusters,
    });
    const hasCheckpoint = org.catalog.getCheckpoint(d.shardKey, connector.name) != null;
    org.catalog.enqueue({ shardKey: d.shardKey, task: hasCheckpoint ? 'delta' : 'full' });
  }
  const reports: CrawlReport[] = [];
  await org.scheduler.drainQueue(async (task) => {
    const d = descriptors.get(task.shardKey);
    if (!d) throw new Error(`no descriptor for queued shard ${task.shardKey}`);
    reports.push(await runCrawl(org, connector, d, { mode: opts.mode ?? task.task }));
  });
  return reports;
}
