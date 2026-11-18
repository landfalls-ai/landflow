/**
 * AG16: a bound Run an Agent / Run a Team node keeps its bubbles' box clear (`bubbleFootprint`, lib/shared/agent-bubbles.ts):
 * Tidy up and a placed node never put another node on its bubbles. Pure, so the layout is testable without a canvas. A node that
 * overlaps a box goes right of it (+ 40) when it comes after the bound node (a next step), and below it otherwise.
 */
import { BUBBLE, bubbleFootprint } from '@/lib/shared/agent-bubbles';

export interface ClearBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The bubbles this node draws (0: none, not a bound node). */
  bubbles?: number;
  /** Real wired sub-nodes of this node: they sit under it by design and are not moved off its box. */
  subNodes?: ReadonlySet<string>;
  /** The x ranges, relative to this node's left, of those sub-nodes: the bubble row is shifted past them (`bubbleGraph` draws it so). */
  occupied?: ReadonlyArray<{ x: number; width: number }>;
  /** The nodes after this one on the main chain, all the way down: they go with it when it moves below the bubbles. */
  downstream?: ReadonlySet<string>;
}

const GAP_X = 40;
const GAP_Y = 24;

/**
 * The box a bound node keeps clear, in canvas coordinates: from the bubble row's top (the node's own row, its slot labels and +
 * buttons are the node's, not the bubbles') down to the row's bottom. A node beside the bound node in its own row is never in it.
 */
export function footprintBox(b: ClearBox): { x0: number; x1: number; y0: number; y1: number } | undefined {
  if (!b.bubbles) return undefined;
  const fp = bubbleFootprint(b.width, b.bubbles, b.occupied);
  // A tall tile (a team's roster) pushes the bubbles down with it (agent-bubbles.tsx `bubbleGraph`).
  const extra = Math.max(0, b.height + 64 - 200);
  return { x0: b.x + fp.left, x1: b.x + fp.right, y0: b.y + BUBBLE.below + extra, y1: b.y + fp.bottom + extra };
}

/**
 * The positions nodes must move to so none overlaps a bound node's box. `movable` limits what may move (a node being placed);
 * without it every node but the bound one may. Returns only the nodes that moved.
 */
export function clearOfBubbles(boxes: readonly ClearBox[], movable?: ReadonlySet<string>): Record<string, { x: number; y: number }> {
  const at = new Map(boxes.map((b) => [b.id, { ...b }]));
  const moved: Record<string, { x: number; y: number }> = {};
  for (let pass = 0; pass < 12; pass++) {
    let changed = false;
    for (const p of at.values()) {
      const box = footprintBox(p);
      if (!box) continue;
      for (const n of at.values()) {
        if (n.id === p.id || p.subNodes?.has(n.id) || (movable && !movable.has(n.id))) continue;
        const overlaps = n.x < box.x1 && n.x + n.width > box.x0 && n.y < box.y1 && n.y + n.height > box.y0;
        if (!overlaps) continue;
        // After the bound node (its centre past the bound node's right edge): a next step, to the right; else below.
        if (n.x + n.width / 2 > p.x + p.width) {
          // A next step goes right of the bubbles, and every later column goes with it (the column gap stays).
          const from = n.x;
          const d = box.x1 + GAP_X - n.x;
          for (const m of at.values()) {
            if (m.id === p.id || m.x < from || p.subNodes?.has(m.id) || (movable && !movable.has(m.id))) continue;
            m.x += d;
            moved[m.id] = { x: m.x, y: m.y };
          }
        } else {
          // Below the bubbles, and its downstream main chain with it (the chain's lines never run back up).
          const d = box.y1 + GAP_Y - n.y;
          for (const m of [n, ...[...(n.downstream ?? [])].flatMap((id) => at.get(id) ?? [])]) {
            if (m.id === p.id || p.subNodes?.has(m.id) || (m !== n && movable && !movable.has(m.id))) continue;
            m.y += d;
            moved[m.id] = { x: m.x, y: m.y };
          }
        }
        changed = true;
      }
    }
    if (!changed) break;
  }
  return moved;
}

/** The x ranges, relative to `node`'s left, of the real sub-nodes still wired into it (what `bubbleGraph` shifts its row past). */
export function occupiedOf(
  node: { id: string; position: { x: number } },
  edges: ReadonlyArray<{ source: string; target: string; data?: { connectionType?: string } }>,
  byId: ReadonlyMap<string, { position: { x: number }; measured?: { width?: number } }>,
): Array<{ x: number; width: number }> {
  return edges
    .filter((e) => e.target === node.id && e.data?.connectionType !== 'main')
    .flatMap((e) => {
      const sub = byId.get(e.source);
      return sub ? [{ x: sub.position.x - node.position.x, width: sub.measured?.width ?? 64 }] : [];
    });
}
