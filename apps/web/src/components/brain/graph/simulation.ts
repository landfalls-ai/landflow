/**
 * Layout: a d3-force simulation over the graph's nodes (a force link, charge, collision and centring), stepped from the view's animation frames.
 *
 * Adapted from Supermemory's memory-graph (packages/memory-graph/src/canvas/simulation.ts), MIT licence, Copyright (c) 2025 supermemory (commit 9547bd0f).
 * Changed for Landflow: the document and space clustering is gone, forces are tuned for facts around subjects, the simulation is stepped by the caller with a time budget (2 s) and pauses while the tab is hidden. See ./NOTICE.md and the repository's THIRD_PARTY_NOTICES.md.
 */
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type ForceLink } from 'd3-force';
import type { LayoutEdge, LayoutNode } from './types';

export const FORCE_CONFIG = {
  linkDistance: { about: 70, version: 38 },
  linkStrength: { about: 0.5, version: 0.8 },
  chargeStrength: -120,
  collisionRadius: { subject: 22, fact: 11 },
  collisionStrength: 0.8,
  centeringStrength: 0.04,
  alphaDecay: 0.04,
  alphaMin: 0.02,
  velocityDecay: 0.45,
  /** A few ticks run before the first frame, so the graph does not start as a ball. */
  preSettleTicks: 40,
  ticksPerFrame: 4,
} as const;

/** A graph settles within this (FR-7), then the simulation stops. */
export const SETTLE_BUDGET_MS = 2000;

export class ForceSimulation {
  private sim: Simulation<LayoutNode, LayoutEdge> | null = null;
  private startedAt: number | undefined;
  private paused = false;

  /** Start over with these nodes (positions they already have are kept). */
  init(nodes: LayoutNode[], edges: LayoutEdge[]): void {
    this.destroy();
    const sim = forceSimulation<LayoutNode>(nodes).alphaDecay(FORCE_CONFIG.alphaDecay).alphaMin(FORCE_CONFIG.alphaMin).velocityDecay(FORCE_CONFIG.velocityDecay);
    sim.force(
      'link',
      forceLink<LayoutNode, LayoutEdge>(edges)
        .id((d) => d.id)
        .distance((l) => FORCE_CONFIG.linkDistance[l.type === 'about' ? 'about' : 'version'])
        .strength((l) => FORCE_CONFIG.linkStrength[l.type === 'about' ? 'about' : 'version']),
    );
    sim.force('charge', forceManyBody<LayoutNode>().strength(FORCE_CONFIG.chargeStrength));
    sim.force('collide', forceCollide<LayoutNode>().radius((d) => FORCE_CONFIG.collisionRadius[d.kind]).strength(FORCE_CONFIG.collisionStrength));
    sim.force('x', forceX<LayoutNode>().strength(FORCE_CONFIG.centeringStrength));
    sim.force('y', forceY<LayoutNode>().strength(FORCE_CONFIG.centeringStrength));
    sim.stop();
    sim.alpha(1);
    for (let i = 0; i < FORCE_CONFIG.preSettleTicks; i++) sim.tick();
    this.sim = sim;
    this.startedAt = undefined;
  }

  /** More nodes (Load more, a toggle): settled positions stay, the new nodes start near where the caller put them. */
  update(nodes: LayoutNode[], edges: LayoutEdge[]): void {
    const sim = this.sim;
    if (!sim) return this.init(nodes, edges);
    sim.nodes(nodes);
    sim.force<ForceLink<LayoutNode, LayoutEdge>>('link')?.links(edges);
    sim.alpha(0.5);
    this.startedAt = undefined;
    this.paused = false;
  }

  /**
   * One animation frame at time `now` (ms): a few ticks. False when the graph is settled, the budget is spent, or the
   * simulation is paused. Animation frames do not fire in a hidden tab, so the view pauses on `visibilitychange` (see
   * `handleVisibility`): the heat is kept and `resume()` gives the layout a fresh budget.
   */
  frame(now: number): boolean {
    const sim = this.sim;
    if (!sim || this.paused) return false;
    this.startedAt ??= now;
    if (sim.alpha() < FORCE_CONFIG.alphaMin || now - this.startedAt >= SETTLE_BUDGET_MS) {
      this.stop();
      return false;
    }
    for (let i = 0; i < FORCE_CONFIG.ticksPerFrame; i++) sim.tick();
    return true;
  }

  /** Stop stepping but keep the heat and the positions (a hidden tab); the budget restarts on `resume()`. */
  pause(): void {
    this.paused = true;
    this.startedAt = undefined;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  resume(): void {
    if (!this.sim) return;
    this.paused = false;
    this.startedAt = undefined;
  }

  /** Whether more frames would move anything. */
  isActive(): boolean {
    return Boolean(this.sim) && (this.sim?.alpha() ?? 0) >= FORCE_CONFIG.alphaMin;
  }

  stop(): void {
    this.sim?.alpha(0).stop();
  }

  destroy(): void {
    this.sim?.stop();
    this.sim = null;
    this.paused = false;
  }
}

/** What the document's `visibilitychange` does to a layout: pause when hidden, pick up again when shown. True when the caller should schedule a frame. */
export function handleVisibility(sim: ForceSimulation, hidden: boolean): boolean {
  if (hidden) {
    sim.pause();
    return false;
  }
  if (!sim.isPaused && !sim.isActive()) return false;
  sim.resume();
  return sim.isActive();
}
