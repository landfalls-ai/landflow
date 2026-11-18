/**
 * AG16 (wave ag4): what the canvas's bubbles read, once per agent, workflow and node, and again when the agent changes. The
 * route is `GET /api/agents/:id/connections` (the published connections, plus the draft's when it differs, and who runs the
 * agent); a version view reads `GET /api/agents/:id/versions/:version/connections` (AG21) instead and never the draft. The cache
 * is a store so the canvas (which draws every node's bubbles) and a node (which draws its chip) share one read. Fresh when:
 * this tab's `AGENT_CHANGED` / `AGENT_SAVED`, another tab's BroadcastChannel message (agent-change.ts turns it into the same
 * window event), and `MOVES_CHANGED`. Nothing here is saved or sent: reads only.
 */
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api, ApiError } from '@/lib/client/api';
import { AGENT_CHANGED, AGENT_SAVED } from '@/lib/client/agent-change';
import { ASSUMED_BUBBLES, bubblesOf, markMoved, MOVES_CHANGED, type AgentMove, type Bubble, type BubbleSource } from '@/lib/shared/agent-bubbles';
import type { ActorConnection } from '@/lib/shared/run-trace';

export interface BubbleAnswer {
  agent: { id: string; name: string; published: boolean; draftDiffers: boolean; icon?: string; color?: string; avatar?: unknown };
  connections: ActorConnection[];
  /** The draft's connections when it differs from what is published (AG16's addition to the route). */
  draft?: ActorConnection[];
  /** The workflows the caller can read that run this agent (AG16's addition to the route). */
  usedBy?: Array<{ workflowId: string; name: string }>;
  /** A version view (AG21's route): the version these connections are. */
  version?: number;
}

export interface BubbleRequest {
  agentId: string;
  workflowId?: string;
  nodeId?: string;
  /** Draw this published version of the agent, read-only (a published or older workflow version, a run); absent: the draft. */
  version?: number;
}

const keyOf = (r: BubbleRequest) => `${r.agentId}|${r.workflowId ?? ''}|${r.nodeId ?? ''}|${r.version ?? ''}`;

interface BubbleData {
  answers: Record<string, BubbleAnswer | null>;
  moves: Record<string, AgentMove[]>;
}
export const useBubbleData = create<BubbleData>(() => ({ answers: {}, moves: {} }));

const requests = new Map<string, BubbleRequest>();
const inflight = new Map<string, Promise<void>>();
const movesRequested = new Set<string>();

/** Read one answer. A workflow not saved yet is a 404: the agent as it is, without the project's settings. */
async function fetchAnswer(r: BubbleRequest): Promise<BubbleAnswer | null> {
  const base = `/api/agents/${encodeURIComponent(r.agentId)}`;
  try {
    if (r.version !== undefined) return await api<BubbleAnswer>(`${base}/versions/${r.version}/connections`, { background: true });
    const scoped = r.workflowId ? `?workflowId=${encodeURIComponent(r.workflowId)}${r.nodeId ? `&nodeId=${encodeURIComponent(r.nodeId)}` : ''}` : '';
    try {
      return await api<BubbleAnswer>(`${base}/connections${scoped}`, { background: true });
    } catch (error) {
      if (scoped && error instanceof ApiError && error.status === 404) return await api<BubbleAnswer>(`${base}/connections`, { background: true });
      throw error;
    }
  } catch {
    return null;
  }
}

function read(r: BubbleRequest, force = false): void {
  const key = keyOf(r);
  requests.set(key, r);
  if (inflight.has(key) || (!force && key in useBubbleData.getState().answers)) return;
  // A failed read sets nothing: what was there stays (a flicker would erase the bubbles) and the next mount or change asks again.
  const run = fetchAnswer(r).then((answer) => {
    inflight.delete(key);
    if (answer) useBubbleData.setState((s) => ({ answers: { ...s.answers, [key]: answer } }));
  });
  inflight.set(key, run);
}

/** Forget and re-read what was read for an agent (it changed). */
export function refreshAgent(agentId: string): void {
  for (const r of requests.values()) if (r.agentId === agentId && r.version === undefined) read(r, true);
}

/** The flow's moves (AG17's record) newest first; a 404 (the route not there, a workflow not saved) is no moves. */
function readMoves(workflowId: string, force = false): void {
  if (!force && movesRequested.has(workflowId)) return;
  movesRequested.add(workflowId);
  void api<{ moves: AgentMove[] }>(`/api/workflows/${encodeURIComponent(workflowId)}/agent-moves`, { background: true }).then(
    (r) => useBubbleData.setState((s) => ({ moves: { ...s.moves, [workflowId]: r.moves ?? [] } })),
    () => useBubbleData.setState((s) => (workflowId in s.moves ? s : { moves: { ...s.moves, [workflowId]: [] } })),
  );
}

/** Forget everything read (tests, and a different workflow opened). */
export function resetBubbleData(): void {
  requests.clear();
  inflight.clear();
  movesRequested.clear();
  useBubbleData.setState({ answers: {}, moves: {} });
}

if (typeof window !== 'undefined') {
  const onAgent = (e: Event) => {
    const agentId = (e as CustomEvent<{ agentId?: string }>).detail?.agentId;
    if (agentId) refreshAgent(agentId);
  };
  window.addEventListener(AGENT_CHANGED, onAgent);
  window.addEventListener(AGENT_SAVED, onAgent);
  window.addEventListener(MOVES_CHANGED, (e) => {
    const workflowId = (e as CustomEvent<{ workflowId?: string }>).detail?.workflowId;
    for (const id of workflowId ? [workflowId] : [...movesRequested]) readMoves(id, true);
    // What moved changes the agents' drafts: the bubbles are read again too.
    for (const r of requests.values()) if (!workflowId || r.workflowId === workflowId) read(r, true);
  });
}

/** One answer, read when first asked (undefined until read, or when the caller cannot read the agent). */
export function useBubbleAnswer(request: BubbleRequest | undefined): BubbleAnswer | undefined {
  const key = request ? keyOf(request) : '';
  useEffect(() => {
    if (request) read(request);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return useBubbleData((s) => (key ? (s.answers[key] ?? undefined) : undefined));
}

/** The answers of many nodes at once (the canvas draws every bound node's bubbles), by node id. */
export function useBubbleAnswers(requests_: ReadonlyArray<BubbleRequest & { nodeId: string }>): Record<string, BubbleAnswer | undefined> {
  const keys = requests_.map(keyOf).join('\n');
  useEffect(() => {
    for (const r of requests_) read(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);
  const answers = useBubbleData((s) => s.answers);
  const out: Record<string, BubbleAnswer | undefined> = {};
  for (const r of requests_) out[r.nodeId] = answers[keyOf(r)] ?? undefined;
  return out;
}

/** The flow's moves, read once and again on `MOVES_CHANGED`. */
export function useFlowMoves(workflowId: string | undefined): AgentMove[] {
  useEffect(() => {
    if (workflowId) readMoves(workflowId);
  }, [workflowId]);
  return useBubbleData((s) => (workflowId ? (s.moves[workflowId] ?? EMPTY) : EMPTY));
}
const EMPTY: AgentMove[] = [];

/**
 * The agent version each bound node of a workflow version drew when it was published (AG21's `GET /api/workflows/:id/versions/
 * :versionId/pins`), by node id. A 404 (a version with no pins, or a host without the route) is no map: the preview draws as the
 * base does, with no chip. A team node's first pin is its lead's.
 */
export function usePinnedVersions(workflowId: string | undefined, versionId: string | undefined): Record<string, number> | undefined {
  const [pins, setPins] = useState<{ key: string; map?: Record<string, number> }>();
  const key = workflowId && versionId ? `${workflowId}|${versionId}` : '';
  useEffect(() => {
    if (!key) return;
    let live = true;
    api<{ pins: Array<{ nodeId: string; version: number }> }>(`/api/workflows/${encodeURIComponent(workflowId!)}/versions/${encodeURIComponent(versionId!)}/pins`, { background: true }).then(
      (r) => {
        const map: Record<string, number> = {};
        for (const p of r.pins ?? []) if (!(p.nodeId in map)) map[p.nodeId] = p.version;
        if (live) setPins({ key, ...(Object.keys(map).length && { map }) });
      },
      () => live && setPins({ key }),
    );
    return () => {
      live = false;
    };
  }, [key, workflowId, versionId]);
  return pins?.key === key ? pins.map : undefined;
}

const BUBBLE_KINDS = new Set(['model', 'memory', 'tool', 'knowledge', 'agent']);

/** What the bubbles draw from one list of connections: the agent's own (not the flow's wired sub-nodes, not its runtime), memory always present. */
function sourcesOf(list: readonly ActorConnection[]): BubbleSource[] {
  const own = list.filter((c) => BUBBLE_KINDS.has(c.kind) && c.from !== 'flow');
  const mapped: BubbleSource[] = own.map((c) =>
    c.kind === 'memory'
      ? { ...c, name: 'Across sessions', detail: 'Memory' }
      : c.credential === 'credential missing'
        ? // A deleted credential is a missing one for the person: they pick again.
          { ...c, credential: 'missing' }
        : c,
  );
  return mapped.some((c) => c.kind === 'memory') ? mapped : [...mapped, { kind: 'memory', name: 'This conversation', detail: 'Memory' }];
}

/**
 * The bubbles of an answer: the draft's, each marked against the published version (`bubblesOf`), and moved ones marked
 * `movedHere` when the node's flow moved them in. A version view draws that version's connections, unmarked.
 */
export function bubblesFromAnswer(answer: BubbleAnswer | undefined, moves: readonly AgentMove[] = [], nodeId?: string): Bubble[] {
  if (!answer) return [];
  const published = sourcesOf(answer.connections);
  const bubbles = answer.version !== undefined || !answer.draft ? bubblesOf(published) : bubblesOf(published, sourcesOf(answer.draft));
  return nodeId && answer.version === undefined ? markMoved(bubbles, moves, nodeId) : bubbles;
}

/** How many bubbles a node bound to this agent has drawn (for Tidy up and placing a node), or the assumed count before they are read. */
export function bubbleCountOf(agentId: string | undefined, nodeId?: string): number {
  if (!agentId) return 0;
  const { answers } = useBubbleData.getState();
  const prefix = `${agentId}|`;
  const exact = Object.entries(answers).find(([k, a]) => a && k.startsWith(prefix) && (!nodeId || k.split('|')[2] === nodeId) && k.endsWith('|'));
  return exact?.[1] ? bubblesFromAnswer(exact[1]).length : ASSUMED_BUBBLES;
}

/** The agent's page at an ability, in a new tab (`tab=abilities&open=<row>`, and `tool=<id>` for a tool's own row). */
export const agentLink = (agentId: string, open: 'model' | 'memory' | 'capabilities', toolId?: string) =>
  `/agents/${encodeURIComponent(agentId)}?tab=abilities&open=${open}${toolId ? `&tool=${encodeURIComponent(toolId)}` : ''}`;

/** Who runs this agent, from what is read (for the confirm before a change made outside a bubble's menu). */
export function usedByOf(agentId: string, nodeId?: string, workflowId?: string): Array<{ workflowId: string; name: string }> | undefined {
  const { answers } = useBubbleData.getState();
  const key = `${agentId}|${workflowId ?? ''}|${nodeId ?? ''}|`;
  return answers[key]?.usedBy ?? Object.entries(answers).find(([k, a]) => a?.usedBy && k.startsWith(`${agentId}|`))?.[1]?.usedBy;
}

/** The agent a node runs: a Run an Agent node's plain `agentId`, a Run a Team node's lead (`leads`, by team id); an expression is none. */
export function boundAgentOf(wf: { type: string; parameters?: Record<string, unknown> } | undefined, leads: Record<string, string> = {}): string | undefined {
  if (!wf) return undefined;
  const p = wf.parameters ?? {};
  if (wf.type === 'core.messageAgent') {
    const id = p.agentId;
    return typeof id === 'string' && id.trim() && !id.trim().startsWith('=') && !id.includes('{{') ? id : undefined;
  }
  if (wf.type === 'core.runTeam') return typeof p.teamId === 'string' ? leads[p.teamId] : undefined;
  return undefined;
}

/** How many bubbles a bound node draws, for the layout (Tidy up, placing a node): the agent's when read, else the assumed count; none for a node that is not bound. */
export function boundCountOf(wf: { type: string; parameters?: Record<string, unknown> }, nodeId: string): number {
  const p = wf.parameters ?? {};
  const plain = (v: unknown) => typeof v === 'string' && v.trim() !== '' && !v.trim().startsWith('=') && !v.includes('{{');
  if (wf.type === 'core.messageAgent' && plain(p.agentId)) return bubbleCountOf(p.agentId as string, nodeId);
  if (wf.type === 'core.runTeam' && plain(p.teamId)) return ASSUMED_BUBBLES;
  return 0;
}
