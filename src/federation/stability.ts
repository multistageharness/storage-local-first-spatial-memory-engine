/**
 * IDEA.v2 §5.3 — StabilityTracker: causal-stability GC.
 *
 * Causal stability (IDEA.v1 "Cloud-Assisted Causal Stability") is
 * achieved for an update once EVERY registered replica has acknowledged
 * it. The tracker keeps per-(replica, graph) acknowledged Yjs state
 * vectors in the catalog; the org-wide stable frontier is the per-client
 * MINIMUM clock across all replicas. compactStable() only collapses
 * atoms whose entire history sits below that frontier — history no
 * replica could still need.
 */
import * as Y from 'yjs';
import type { Catalog } from './catalog.js';
import type { MemoryEngine } from '../engine.js';

export class StabilityTracker {
  constructor(private readonly catalog: Catalog) {}

  /** record a replica's acknowledged state vector for one graph/shard */
  ack(replicaId: string, graphId: string, stateVector: Uint8Array): void {
    this.catalog.ackReplicaVector(replicaId, graphId, stateVector);
  }

  /**
   * Org-wide stable frontier for a graph: per-client minimum clock over
   * ALL registered replicas. A client absent from any replica's vector
   * has frontier 0 (nothing of it is stable). Null when no replicas are
   * registered — nothing can be proven stable.
   */
  stableFrontier(graphId: string): Map<number, number> | null {
    const vectors = this.catalog.listReplicaVectors(graphId);
    if (vectors.length === 0) return null;
    const decoded = vectors.map((v) => Y.decodeStateVector(new Uint8Array(v.stateVector)));
    const frontier = new Map<number, number>();
    // start from the first replica's clients, then clamp by the rest
    for (const [client, clock] of decoded[0]) frontier.set(client, clock);
    for (let i = 1; i < decoded.length; i++) {
      for (const [client, clock] of frontier) {
        const other = decoded[i].get(client) ?? 0;
        frontier.set(client, Math.min(clock, other));
      }
      // clients the first replica had but later ones don't are clamped
      // above; clients only later replicas have stay absent (min = 0)
    }
    return frontier;
  }

  /** true when every (client, clock) of `sv` is at or below the frontier */
  static isStable(sv: Map<number, number>, frontier: Map<number, number>): boolean {
    for (const [client, clock] of sv) {
      if ((frontier.get(client) ?? 0) < clock) return false;
    }
    return true;
  }

  /**
   * Compact only atoms whose full history is below the all-replica
   * frontier (safe: no replica can still send pre-frontier updates that
   * the collapsed baseline would mis-merge — and if one does anyway, the
   * epoch check degrades it to CONFLICT, not corruption).
   */
  async compactStable(
    engine: MemoryEngine,
    graphId: string,
    opts: { nodeIds: number[]; limit?: number } ,
  ): Promise<{ compacted: number[]; skipped: number[] }> {
    const frontier = this.stableFrontier(graphId);
    const compacted: number[] = [];
    const skipped: number[] = [];
    if (!frontier) return { compacted, skipped: [...opts.nodeIds] };
    const limit = opts.limit ?? 100;
    for (const nodeId of opts.nodeIds) {
      if (compacted.length >= limit) break;
      const blob = await engine.crdt.load(nodeId);
      if (!blob) {
        skipped.push(nodeId);
        continue;
      }
      const sv = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(blob));
      if (StabilityTracker.isStable(sv, frontier)) {
        await engine.compactAtom(nodeId);
        compacted.push(nodeId);
      } else {
        skipped.push(nodeId);
      }
    }
    return { compacted, skipped };
  }
}
