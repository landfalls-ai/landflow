/**
 * "Building, step by step" (docs/assistant.md#building-step-by-step): the steps a change is made of, for the card at the
 * side of the canvas, and the ghost nodes and connections it adds, for the canvas. Pure: the assistant's tool calls and the
 * ops of its proposals go in, steps come out. A proposal arrives whole, so the editor reveals its steps one by one
 * (`revealed`); nothing here touches the workflow.
 */
import { applyOps, type AssistantOp, type DescriptorLookup } from './assistant-ops';
import type { ConnectionType, Workflow } from './types';

export type StepKind = 'read' | 'add' | 'wire' | 'set' | 'remove' | 'rename' | 'team' | 'settings' | 'think';

/** A step before it has a state: what it is, which ghosts it brings in. */
export interface StepDef {
  id: string;
  kind: StepKind;
  /** "Add Ask for approval", "Connect Deny → Writer". */
  title: string;
  /** What it is doing while in progress: "Wiring the connections". */
  doing: string;
  /** The parts it names: nodes, connections, parameters. */
  parts: string[];
  /** The tool call did not work out. */
  failed?: boolean;
  /** Ghost node ids this step adds to the canvas. */
  adds: string[];
  /** Ghost connections this step draws, as [source id, target id]. */
  links: Array<[string, string]>;
}

export interface BuildStep extends StepDef {
  state: 'done' | 'active' | 'todo';
}

export interface GhostNode {
  id: string;
  name: string;
  type: string;
  position: [number, number];
  /** Handles the connections need: "main:0", "ai_tool:0". */
  ins: string[];
  outs: string[];
  /** Index into the plan's steps: the node appears when that step is reached. */
  step: number;
}

export interface GhostLink {
  id: string;
  type: ConnectionType;
  source: string;
  sourceIndex: number;
  target: string;
  targetIndex: number;
  /** Index into the plan's steps: the connection draws when that step is reached. */
  step: number;
}

export interface Plan {
  steps: StepDef[];
  nodes: GhostNode[];
  links: GhostLink[];
  /** Ops that could not apply to this workflow (the reasons). */
  dropped: string[];
}

const shorten = (text: string, max = 40) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The op steps and ghosts for `ops` applied to `workflow` (applied ops only: what Apply would do). */
export function planOf(workflow: Workflow, ops: AssistantOp[], lookup: DescriptorLookup): Plan {
  let counter = 0;
  const result = applyOps(workflow, ops, lookup, { newId: () => `ghost-${++counter}` });
  const ghostIds = new Set(result.added);
  const nameOf = new Map<string, string>(result.workflow.nodes.map((n) => [n.id, n.name]));
  const byRef = new Map<string, string>();
  const idOf = (reference: string): string | undefined =>
    byRef.get(reference) ?? (workflow.nodes.find((n) => n.name === reference) ?? workflow.nodes.find((n) => n.id === reference) ?? workflow.nodes.find((n) => n.name.toLowerCase() === reference.toLowerCase()))?.id;
  const label = (reference: string) => {
    const id = idOf(reference);
    return (id && nameOf.get(id)) || reference;
  };

  const steps: StepDef[] = [];
  const stepOfNode = new Map<string, number>();
  let added = 0;
  const applied = result.applied;
  for (let i = 0; i < applied.length; i++) {
    const op = applied[i];
    const id = `op${steps.length}`;
    switch (op.op) {
      case 'addNode': {
        const nodeId = result.added[added++];
        const name = (nodeId && nameOf.get(nodeId)) || op.name || op.type;
        if (nodeId) {
          byRef.set(op.ref ?? name, nodeId);
          byRef.set(name, nodeId);
        }
        const kind = lookup(op.type)?.displayName;
        const near = op.before ? `before ${label(op.before)}` : op.after ? `after ${label(op.after)}` : undefined;
        const links: StepDef['links'] = [];
        const other = op.before ?? op.after;
        const otherId = other ? idOf(other) : undefined;
        if (nodeId && otherId) links.push(op.before ? [nodeId, otherId] : [otherId, nodeId]);
        if (nodeId) stepOfNode.set(nodeId, steps.length);
        steps.push({
          id,
          kind: 'add',
          title: `Add ${name}`,
          doing: `Adding ${name}`,
          parts: [name, ...(kind && kind !== name ? [kind] : []), ...(near ? [near] : [])],
          adds: nodeId && ghostIds.has(nodeId) ? [nodeId] : [],
          links,
        });
        break;
      }
      case 'connect':
      case 'disconnect': {
        // Consecutive connections are one step: "Wire 3 connections".
        const group: Array<Extract<AssistantOp, { op: 'connect' | 'disconnect' }>> = [op];
        while (applied[i + 1]?.op === 'connect' || applied[i + 1]?.op === 'disconnect') group.push(applied[++i] as (typeof group)[number]);
        const parts = group.map((g) => `${g.op === 'disconnect' ? 'Cut ' : ''}${shorten(label(g.from))} → ${shorten(label(g.to))}`);
        const links: StepDef['links'] = [];
        for (const g of group) {
          const from = idOf(g.from);
          const to = idOf(g.to);
          if (g.op === 'connect' && from && to) links.push([from, to]);
        }
        const only = group[0];
        steps.push({
          id,
          kind: 'wire',
          title: group.length > 1 ? `Wire ${group.length} connections` : only.op === 'disconnect' ? `Disconnect ${parts[0].slice(4)}` : `Connect ${parts[0]}`,
          doing: group.length > 1 ? 'Wiring the connections' : 'Wiring a connection',
          parts,
          adds: [],
          links,
        });
        break;
      }
      case 'setParameters': {
        const keys = Object.keys(op.parameters);
        steps.push({ id, kind: 'set', title: `Set up ${label(op.node)}`, doing: `Setting up ${label(op.node)}`, parts: [label(op.node), ...keys.slice(0, 4), ...(keys.length > 4 ? [`+${keys.length - 4} more`] : [])], adds: [], links: [] });
        break;
      }
      case 'removeNode':
        steps.push({ id, kind: 'remove', title: `Remove ${label(op.node)}`, doing: `Removing ${label(op.node)}`, parts: [label(op.node)], adds: [], links: [] });
        break;
      case 'renameNode':
        steps.push({ id, kind: 'rename', title: `Rename ${label(op.node)}`, doing: `Renaming ${label(op.node)}`, parts: [label(op.node), op.name], adds: [], links: [] });
        break;
      case 'turnIntoTeam':
        steps.push({ id, kind: 'team', title: `Turn ${label(op.node)} into a team`, doing: `Turning ${label(op.node)} into a team`, parts: [label(op.node)], adds: [], links: [] });
        break;
      case 'setNodeSettings':
        steps.push({ id, kind: 'settings', title: `Change the run settings of ${label(op.node)}`, doing: `Changing the run settings of ${label(op.node)}`, parts: [label(op.node), ...Object.keys(op.settings)], adds: [], links: [] });
        break;
      case 'setWorkflowSettings':
        steps.push({ id, kind: 'settings', title: 'Change the workflow settings', doing: 'Changing the workflow settings', parts: Object.keys(op.settings), adds: [], links: [] });
        break;
    }
  }

  // The ghosts: nodes the ops added that are still there, and connections that did not exist before.
  const key = (c: { type: string; source: string; sourceIndex: number; target: string; targetIndex: number }) => `${c.type}|${c.source}|${c.sourceIndex}|${c.target}|${c.targetIndex}`;
  const had = new Set(workflow.connections.map(key));
  const links: GhostLink[] = result.workflow.connections
    .filter((c) => !had.has(key(c)))
    .map((c) => {
      const drawn = steps.findIndex((s) => s.links.some(([from, to]) => from === c.source && to === c.target));
      const step = drawn >= 0 ? drawn : Math.max(stepOfNode.get(c.source) ?? 0, stepOfNode.get(c.target) ?? 0);
      return { id: c.id, type: c.type, source: c.source, sourceIndex: c.sourceIndex, target: c.target, targetIndex: c.targetIndex, step };
    });
  const handles = (id: string, side: 'source' | 'target') => {
    const set = new Set<string>();
    for (const c of links) {
      if (side === 'source' && c.source === id) set.add(`${c.type}:${c.type === 'main' ? c.sourceIndex : 0}`);
      if (side === 'target' && c.target === id) set.add(`${c.type}:${c.type === 'main' ? c.targetIndex : 0}`);
    }
    return [...set];
  };
  const nodes: GhostNode[] = result.workflow.nodes
    .filter((n) => ghostIds.has(n.id))
    .map((n) => ({ id: n.id, name: n.name, type: n.type, position: n.position, ins: handles(n.id, 'target'), outs: handles(n.id, 'source'), step: stepOfNode.get(n.id) ?? 0 }));
  return { steps, nodes, links, dropped: result.dropped };
}

export interface ToolCall {
  label: string;
  ok: boolean;
}

/** The tool calls as steps ("Read the workflow · 4 nodes"); the proposal's own call is left out, its ops are the steps. */
export function toolSteps(tools: ToolCall[], nodeCount?: number): StepDef[] {
  return tools
    .filter((t) => !/^Proposed \d/.test(t.label) && !t.label.startsWith('Skipped a repeated'))
    .map((t, i) => ({
      id: `tool${i}`,
      kind: 'read' as const,
      title: t.label,
      doing: t.label,
      parts: nodeCount !== undefined && /^Read the workflow/.test(t.label) ? [`${nodeCount} node${nodeCount === 1 ? '' : 's'}`] : [],
      failed: !t.ok,
      adds: [],
      links: [],
    }));
}

export interface BuildInput {
  tools: ToolCall[];
  plan: Pick<Plan, 'steps'>;
  /** How many of the plan's steps are finished; the next one is in progress. */
  revealed: number;
  /** The assistant is still working on the reply. */
  working: boolean;
  nodeCount?: number;
}

/**
 * Every step in order with its state: tool calls are done as they stream, the plan's steps tick off as `revealed` grows, and
 * while the assistant is still working a "thinking" step is in progress after the last one.
 */
export function buildSteps({ tools, plan, revealed, working, nodeCount }: BuildInput): BuildStep[] {
  const steps: BuildStep[] = toolSteps(tools, nodeCount).map((s) => ({ ...s, state: 'done' }));
  plan.steps.forEach((s, i) => steps.push({ ...s, state: i < revealed ? 'done' : i === revealed ? 'active' : 'todo' }));
  if (working && revealed >= plan.steps.length) {
    const title = steps.length ? 'Working out the next step' : 'Reading your request';
    steps.push({ id: 'think', kind: 'think', title, doing: title, parts: [], adds: [], links: [], state: 'active' });
  }
  return steps;
}

/** How far the plan is, 0 to 1: done steps over all (the step still being thought of counts as one more, never the last). */
export function stepProgress(steps: BuildStep[]): number {
  const real = steps.filter((s) => s.kind !== 'think');
  if (!real.length) return 0;
  const done = real.filter((s) => s.state === 'done').length;
  return steps.some((s) => s.kind === 'think') ? Math.min(done / (real.length + 1), 0.95) : done / real.length;
}

/** The ghosts to draw with `revealed` plan steps done: the step in progress shows too, shimmering (`active`). */
export function visibleGhosts(plan: Plan, revealed: number): { nodes: Array<GhostNode & { active: boolean }>; links: GhostLink[] } {
  return {
    nodes: plan.nodes.filter((n) => n.step <= revealed).map((n) => ({ ...n, active: n.step === revealed })),
    links: plan.links.filter((l) => l.step <= revealed),
  };
}
