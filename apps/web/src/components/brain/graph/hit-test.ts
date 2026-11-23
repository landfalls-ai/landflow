/**
 * Hit test: a spatial grid that finds the node under a point, for hover and click.
 *
 * Adapted from Supermemory's memory-graph (packages/memory-graph/src/canvas/hit-test.ts), MIT licence, Copyright (c) 2025 supermemory (commit 9547bd0f).
 * Changed for Landflow: subjects (squares) and facts (circles) replace documents and memories. See ./NOTICE.md and the repository's THIRD_PARTY_NOTICES.md.
 */
import type { LayoutNode } from './types';

export class SpatialIndex {
  private grid = new Map<string, LayoutNode[]>();
  private cellSize = 200;
  private lastHash = 0;

  /** Index `nodes`; false when none moved since the last call. */
  rebuild(nodes: LayoutNode[]): boolean {
    const hash = this.computeHash(nodes);
    if (hash === this.lastHash) return false;
    this.lastHash = hash;
    this.grid.clear();
    for (const node of nodes) {
      const key = `${Math.floor(node.x / this.cellSize)},${Math.floor(node.y / this.cellSize)}`;
      let cell = this.grid.get(key);
      if (!cell) {
        cell = [];
        this.grid.set(key, cell);
      }
      cell.push(node);
    }
    return true;
  }

  /** The topmost node at a world point, or null. */
  queryPoint(worldX: number, worldY: number): LayoutNode | null {
    const cx = Math.floor(worldX / this.cellSize);
    const cy = Math.floor(worldY / this.cellSize);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = this.grid.get(`${cx + dx},${cy + dy}`);
        if (!cell) continue;
        for (let i = cell.length - 1; i >= 0; i--) {
          const node = cell[i];
          if (node && this.hitTest(node, worldX, worldY)) return node;
        }
      }
    }
    return null;
  }

  private hitTest(node: LayoutNode, wx: number, wy: number): boolean {
    const half = node.size * 0.5;
    if (node.kind === 'subject') return Math.abs(wx - node.x) <= half && Math.abs(wy - node.y) <= half;
    const dx = wx - node.x;
    const dy = wy - node.y;
    return dx * dx + dy * dy <= half * half;
  }

  private computeHash(nodes: LayoutNode[]): number {
    let hash = nodes.length;
    for (const n of nodes) {
      // Tenth-of-a-pixel positions plus a hash of the id, so a swap of two nodes is seen too.
      let idHash = 0;
      for (let i = 0; i < n.id.length; i++) idHash = ((idHash << 5) - idHash + n.id.charCodeAt(i)) | 0;
      hash = (hash * 31 + idHash) | 0;
      hash = (hash * 31 + (Math.round(n.x * 10) | 0)) | 0;
      hash = (hash * 31 + (Math.round(n.y * 10) | 0)) | 0;
    }
    return hash;
  }
}
