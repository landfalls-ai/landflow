/**
 * Version chains: the versions of a fact in order, found by walking parent ids both ways.
 *
 * Adapted from Supermemory's memory-graph (packages/memory-graph/src/canvas/version-chain.ts), MIT licence, Copyright (c) 2025 supermemory (commit 9547bd0f).
 * Changed for Landflow: it indexes Landflow's fact nodes (parentId) instead of documents' memories, and says which versions are earlier (drawn faded). See ./NOTICE.md and the repository's THIRD_PARTY_NOTICES.md.
 */
import type { GraphFactNode, GraphNode } from '@/lib/shared/brain-graph';

export interface ChainEntry {
  id: string;
  version: number;
  statement: string;
  forgotten: boolean;
  latest: boolean;
}

export class VersionChainIndex {
  private byFact = new Map<string, GraphFactNode>();
  private children = new Map<string, string[]>();
  private cache = new Map<string, ChainEntry[]>();
  private last: GraphNode[] | null = null;

  rebuild(nodes: GraphNode[]): void {
    if (nodes === this.last) return;
    this.last = nodes;
    this.byFact.clear();
    this.children.clear();
    this.cache.clear();
    for (const n of nodes) {
      if (n.kind !== 'fact') continue;
      this.byFact.set(n.factId, n);
      if (n.parentId) this.children.set(n.parentId, [...(this.children.get(n.parentId) ?? []), n.factId]);
    }
  }

  /** The chain `factId` is in, oldest first; null for a fact with a single version. */
  getChain(factId: string): ChainEntry[] | null {
    const cached = this.cache.get(factId);
    if (cached) return cached;
    const fact = this.byFact.get(factId);
    if (!fact) return null;
    const seen = new Set<string>();
    const back: GraphFactNode[] = [];
    for (let cur: GraphFactNode | undefined = fact; cur && !seen.has(cur.factId); cur = cur.parentId ? this.byFact.get(cur.parentId) : undefined) {
      seen.add(cur.factId);
      back.push(cur);
    }
    back.reverse();
    // Versions are linear (one child each); a branch follows its first child.
    const forward: GraphFactNode[] = [];
    for (let cur: GraphFactNode | undefined = fact; cur; ) {
      const next: GraphFactNode | undefined = this.byFact.get(this.children.get(cur.factId)?.[0] ?? '');
      if (!next || seen.has(next.factId)) break;
      seen.add(next.factId);
      forward.push(next);
      cur = next;
    }
    const all = [...back, ...forward];
    if (all.length <= 1) return null;
    let lastVersion = 0;
    const chain: ChainEntry[] = all.map((m) => {
      const version = Number.isFinite(m.version) && m.version > lastVersion ? m.version : lastVersion + 1;
      lastVersion = version;
      return { id: m.factId, version, statement: m.statement, forgotten: Boolean(m.forgotten), latest: m.latest };
    });
    for (const entry of chain) this.cache.set(entry.id, chain);
    return chain;
  }

  /** An earlier version: drawn faded behind the latest. */
  isEarlier(factId: string): boolean {
    const f = this.byFact.get(factId);
    return Boolean(f && !f.latest);
  }
}
