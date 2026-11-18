/**
 * AG16: a bound Run an Agent / Run a Team node keeps its bubbles' box clear (`bubbleFootprint`, lib/shared/agent-bubbles.ts):
 * Tidy up and a placed node never put another node on its bubbles. Pure, so the layout is testable without a canvas. A node that
 * overlaps a box goes right of it (+ 40) when it comes after the bound node (a next step), and below it otherwise.
 */
import { bubbleFootprint } from '@/lib/shared/agent-bubbles';

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
}

const GAP_X = 40;
const GAP_Y = 24;

/** The box a bound node keeps clear, in canvas coordinates. */
export function footprintBox(b: ClearBox): { x0: number; x1: number; y0: number; y1: number } | undefined {
  if (!b.bubbles) return undefined;
  const fp = bubbleFootprint(b.width, b.bubbles);
  // A tall tile (a team's roster) pushes the bubbles down with it (agent-bubbles.tsx `bubbleGraph`).
  const extra = Math.max(0, b.height + 64 - 200);
  return { x0: b.x + fp.left, x1: b.x + fp.right, y0: b.y, y1: b.y + fp.bottom + extra };
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
        if (n.x + n.width / 2 > p.x + p.width) n.x = box.x1 + GAP_X;
        else n.y = box.y1 + GAP_Y;
        moved[n.id] = { x: n.x, y: n.y };
        changed = true;
      }
    }
    if (!changed) break;
  }
  return moved;
}
