/**
 * The goals tree as plain functions (docs/projects-and-goals.md): flatten it for a list, filter it, pick the parents a
 * goal may have, order the picker's options, fold a long brief. No React, so a test can read it.
 */
import { GOAL_LIMITS, type GoalLevel, type GoalNode, type GoalStatus } from '@/lib/shared/goals';

export interface FlatRow {
  node: GoalNode;
  /** A root goal is depth 1. */
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  parentId?: string;
}

/** The rows a tree shows, in order: a node's children follow it only while it is in `expanded`. */
export function flattenTree(nodes: GoalNode[], expanded: ReadonlySet<string>): FlatRow[] {
  const rows: FlatRow[] = [];
  const walk = (list: GoalNode[], depth: number, parentId?: string) => {
    for (const node of list) {
      const hasChildren = node.children.length > 0;
      const open = hasChildren && expanded.has(node.id);
      rows.push({ node, depth, hasChildren, expanded: open, parentId });
      if (open) walk(node.children, depth + 1, node.id);
    }
  };
  walk(nodes, 1);
  return rows;
}

/** Every node, depth first, with its depth. */
export function allNodes(nodes: GoalNode[]): Array<{ node: GoalNode; depth: number; parentId?: string }> {
  const out: Array<{ node: GoalNode; depth: number; parentId?: string }> = [];
  const walk = (list: GoalNode[], depth: number, parentId?: string) => {
    for (const node of list) {
      out.push({ node, depth, parentId });
      walk(node.children, depth + 1, node.id);
    }
  };
  walk(nodes, 1);
  return out;
}

export const indexGoals = (nodes: GoalNode[]): Map<string, GoalNode> => new Map(allNodes(nodes).map((e) => [e.node.id, e.node]));

/** How deep a subtree is, itself counted: a leaf is 1. */
export function height(node: GoalNode): number {
  return 1 + node.children.reduce((max, child) => Math.max(max, height(child)), 0);
}

/** The ids of the nodes that have children, to start a tree open. */
export const parentIds = (nodes: GoalNode[]): Set<string> => new Set(allNodes(nodes).filter((e) => e.node.children.length).map((e) => e.node.id));

export interface GoalFilter {
  /** Planned and active goals only. */
  activeOnly: boolean;
  projectId?: string;
}

const OPEN: readonly GoalStatus[] = ['planned', 'active'];

/** The tree without what the filter hides; a goal stays when it matches or something under it does. */
export function filterTree(nodes: GoalNode[], filter: GoalFilter): GoalNode[] {
  const matches = (n: GoalNode) => (!filter.activeOnly || OPEN.includes(n.status)) && (!filter.projectId || n.projectId === filter.projectId || n.projects.some((p) => p.id === filter.projectId));
  const keep = (list: GoalNode[]): GoalNode[] =>
    list.flatMap((n) => {
      const children = keep(n.children);
      return matches(n) || children.length ? [{ ...n, children }] : [];
    });
  return keep(nodes);
}

/**
 * The goals `selfId` (or a new goal, when undefined) may sit under, at `level`: a company goal sits under a company goal,
 * a project goal under either; never itself or what is under it; and the tree stays at most four deep, its own subtree
 * counted.
 */
export function allowedParents(goals: GoalNode[], level: GoalLevel, selfId?: string): GoalNode[] {
  const all = allNodes(goals);
  const self = selfId ? all.find((e) => e.node.id === selfId)?.node : undefined;
  const banned = new Set(self ? allNodes([self]).map((e) => e.node.id) : []);
  const below = self ? height(self) : 1;
  return all
    .filter(({ node, depth }) => !banned.has(node.id) && (level === 'project' || node.level === 'company') && depth + below <= GOAL_LIMITS.depth)
    .map((e) => e.node);
}

export interface PickerOption {
  id: string;
  label: string;
  /** "This project" when the goal belongs to or is served by the project in question. */
  group: 'project' | 'other';
}

const indent = (depth: number) => (depth <= 1 ? '' : `${'  '.repeat(depth - 2)}  └ `);

/**
 * The options of a goal picker: visible goals, cancelled ones left out, each indented by its depth. With a project, its
 * goals come first.
 */
export function pickerOptions(goals: GoalNode[], projectId?: string, exclude?: ReadonlySet<string>): PickerOption[] {
  const options = allNodes(goals)
    .filter(({ node }) => node.status !== 'cancelled' && !exclude?.has(node.id))
    .map(({ node, depth }): PickerOption => ({
      id: node.id,
      label: `${indent(depth)}${node.title}`,
      group: projectId && (node.projectId === projectId || node.projects.some((p) => p.id === projectId)) ? 'project' : 'other',
    }));
  return [...options.filter((o) => o.group === 'project'), ...options.filter((o) => o.group === 'other')];
}

/** The first `lines` lines of a text, and whether more was cut (for a card that folds). */
export function briefFold(text: string, lines: number): { text: string; folded: boolean } {
  const all = text.replace(/\r\n/g, '\n').split('\n');
  if (all.length <= lines) return { text: all.join('\n'), folded: false };
  return { text: all.slice(0, lines).join('\n'), folded: true };
}

/** "Under: <parent>" on a card, for a goal that has a parent. */
export function parentTitle(index: Map<string, GoalNode>, goal: Pick<GoalNode, 'parentId'>): string | undefined {
  return goal.parentId ? index.get(goal.parentId)?.title : undefined;
}

/** A target date as "15 Mar 2027" (the date is a plain YYYY-MM-DD, read without a time zone). */
export function formatTarget(date?: string): string | undefined {
  const m = date && /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return undefined;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}
