'use client';
/**
 * AG16 (wave ag4): a Run an Agent node's agent (a Run a Team node's lead), drawn as bubbles under the node's slots, the way
 * n8n draws sub-nodes: its model, memory, tools and knowledge bases are round bubbles on dashed edges to the Chat Model, Memory
 * and Tool slots. Nothing about the agent is written inside the node card (`cardLeaks` is the test). The bubbles are the
 * agent's own: an edit through them changes the saved agent's DRAFT (lib/client/agent-edit.ts), so every workflow that runs
 * it follows, and it is live only after Publish (the chip's button runs the smoke test and the gate, never `skipEval`).
 *
 * The bubbles are derived, not stored: virtual xyflow nodes (`agentBubble`) and edges (`bubble`) the canvas merges into what
 * React Flow draws, as the build ghosts are (editor/building.tsx). They are never in the editor store, the saved workflow, undo,
 * copy and paste or a run. A published or older workflow version draws its pinned agent version instead, read-only (`version`).
 * The look of one bubble is bubble-view.tsx (the contract file Spotlight's agent card shares).
 */
import { useMemo, useState } from 'react';
import { BaseEdge, Handle, Position, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react';
import { ExternalLink, Loader2, UploadCloud } from 'lucide-react';
import { useTeamLeads } from '../agents/faces';
import { announceSaved, publishChange, testDraft } from '@/lib/client/agent-change';
import { SMOKE_SAMPLE } from '@/lib/client/agent-edit';
import { agentLink, boundAgentOf, bubblesFromAnswer, useBubbleAnswer, useBubbleAnswers, useFlowMoves, type BubbleAnswer, type BubbleRequest } from '@/lib/client/agent-bubble-data';
import { BUBBLE, bubblePositions, pendingLine, SLOT_HANDLE, type AgentMove, type Bubble, type LocalOverride } from '@/lib/shared/agent-bubbles';
import { cn } from '@/lib/utils';
import { occupiedOf } from '../editor/bubble-clearance';
import { Popover } from '../ui/popover';
import { BubbleActions, BubbleMenu, type BubbleAction } from './bubble-menu';
import { BubbleView } from './bubble-view';

/** The node's slot clearance under a tall tile (a team's roster): the slot labels and + buttons end before the bubbles start. */
const CLEARANCE = 64;

type NodeLike = { id: string; type?: string; data?: { wf?: { type: string; parameters?: Record<string, unknown> } } };

/** The agent a node runs, for the node's own chip. */
export function useBoundAgent(wf: { type: string; parameters: Record<string, unknown> }): string | undefined {
  const leads = useTeamLeads(wf.type === 'core.runTeam' ? [wf] : undefined);
  return boundAgentOf(wf, leads);
}

// ----------------------------------------------------------------------------------------------------------------- graph

export interface BubbleNodeData extends Record<string, unknown> {
  nodeId: string;
  agentName: string;
  bubble: Bubble;
  request: BubbleRequest;
  /** A version view never writes: no menu of edits, the read-only detail only. */
  readOnly?: boolean;
}
export type BubbleFlowNode = Node<BubbleNodeData, 'agentBubble'>;
export type BubbleFlowEdge = Edge<{ connectionType: string }, 'bubble'>;

/** A bound node as the canvas knows it: where it is, how big, and the wired sub-nodes the bubbles must stay clear of. */
export interface BoundParent {
  id: string;
  position: { x: number; y: number };
  width: number;
  height?: number;
  hidden?: boolean;
  agentName: string;
  request: BubbleRequest;
  /** The x ranges, relative to the node's left, of the real sub-nodes still wired into it (the legacy ones). */
  occupied?: ReadonlyArray<{ x: number; width: number }>;
  readOnly?: boolean;
}

/**
 * The virtual nodes and edges of every bound node's bubbles. Ids are `bubble:<nodeId>:<bubble.id>` and
 * `bubble-edge:<nodeId>:<bubble.id>`; none can be dragged, connected, deleted or selected.
 */
export function bubbleGraph(parents: readonly BoundParent[], bubblesByNode: Readonly<Record<string, readonly Bubble[]>>): { nodes: BubbleFlowNode[]; edges: BubbleFlowEdge[] } {
  const nodes: BubbleFlowNode[] = [];
  const edges: BubbleFlowEdge[] = [];
  for (const parent of parents) {
    const bubbles = bubblesByNode[parent.id] ?? [];
    if (!bubbles.length) continue;
    const spots = bubblePositions(parent.width, bubbles.length, parent.occupied);
    // A tall tile (a team's roster) pushes the row down so the slot labels and + buttons stay clear.
    const extra = Math.max(0, (parent.height ?? 0) + CLEARANCE - BUBBLE.below);
    bubbles.forEach((bubble, i) => {
      const id = `bubble:${parent.id}:${bubble.id}`;
      nodes.push({
        id,
        type: 'agentBubble',
        position: { x: parent.position.x + spots[i].x, y: parent.position.y + spots[i].y + extra },
        data: { nodeId: parent.id, agentName: parent.agentName, bubble, request: parent.request, ...(parent.readOnly && { readOnly: true }) },
        draggable: false,
        connectable: false,
        deletable: false,
        selectable: false,
        focusable: true,
        ...(parent.hidden && { hidden: true }),
      });
      edges.push({
        id: `bubble-edge:${parent.id}:${bubble.id}`,
        type: 'bubble',
        source: id,
        sourceHandle: 'out',
        target: parent.id,
        targetHandle: `${SLOT_HANDLE[bubble.slot]}:0`,
        data: { connectionType: SLOT_HANDLE[bubble.slot] },
        selectable: false,
        deletable: false,
        focusable: false,
        ...(parent.hidden && { hidden: true }),
      });
    });
  }
  return { nodes, edges };
}

/** True for an id the editor must never hand to the store: a bubble or the edge to one. */
export const isBubbleId = (id: string): boolean => id.startsWith('bubble:') || id.startsWith('bubble-edge:');

/** The changes of a node or edge change list that are not a bubble's (React Flow's `id`, or the `item.id` of an add / replace): what the store may hear. */
export function withoutBubbleChanges<C extends object>(changes: readonly C[]): C[] {
  return changes.filter((c) => {
    const id = 'id' in c ? (c as { id: unknown }).id : 'item' in c ? (c as { item?: { id?: unknown } }).item?.id : undefined;
    return !(typeof id === 'string' && isBubbleId(id));
  });
}

const NO_NODES: BubbleFlowNode[] = [];
const NO_EDGES: BubbleFlowEdge[] = [];

/**
 * The canvas's bubble layer: for every bound node of `nodes` (as the canvas draws them), its agent's bubbles, read from the
 * route and marked against the published version and the flow's moves. `versions` (node id → agent version) draws a published
 * workflow version's pinned versions, read-only; without it the agent's draft is drawn and editable.
 */
export function useBubbleLayer(
  nodes: ReadonlyArray<NodeLike & { position: { x: number; y: number }; measured?: { width?: number; height?: number }; hidden?: boolean }>,
  edges: ReadonlyArray<{ source: string; target: string; data?: { connectionType?: string } }>,
  options: { workflowId?: string; versions?: Readonly<Record<string, number | 'draft'>>; readOnly?: boolean } = {},
): { nodes: BubbleFlowNode[]; edges: BubbleFlowEdge[] } {
  // A version view (`versions` given) draws only the nodes it knows a version for; the rest stay as the base draws them.
  const lf = nodes.filter((n) => (n.type === 'lf' || n.type === 'exec') && n.data?.wf && (!options.versions || n.id in options.versions));
  const leads = useTeamLeads(lf.flatMap((n) => (n.data!.wf!.type === 'core.runTeam' ? [n.data!.wf!] : [])));
  const bound = lf.flatMap((n) => {
    const agentId = boundAgentOf(n.data!.wf, leads);
    return agentId ? [{ node: n, agentId }] : [];
  });
  const requests = bound.map(({ node, agentId }) => ({ agentId, nodeId: node.id, ...(options.workflowId && { workflowId: options.workflowId }), ...(typeof options.versions?.[node.id] === 'number' && { version: options.versions[node.id] as number }) }));
  const answers = useBubbleAnswers(requests);
  const moves = useFlowMoves(options.versions ? undefined : options.workflowId);
  return useMemo(() => {
    if (!bound.length) return { nodes: NO_NODES, edges: NO_EDGES };
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const bubblesByNode: Record<string, Bubble[]> = {};
    const parents: BoundParent[] = [];
    bound.forEach(({ node }, i) => {
      const answer = answers[node.id];
      if (!answer) return;
      bubblesByNode[node.id] = bubblesFromAnswer(answer, moves, node.id);
      const occupied = occupiedOf(node, edges, byId); // the same ranges the layout keeps clear (editor/bubble-clearance.ts)
      parents.push({
        id: node.id,
        position: node.position,
        width: node.measured?.width ?? 240,
        ...(node.measured?.height && { height: node.measured.height }),
        ...(node.hidden && { hidden: true }),
        agentName: answer.agent.name,
        request: requests[i],
        occupied,
        ...(options.readOnly && { readOnly: true }),
      });
    });
    return bubbleGraph(parents, bubblesByNode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, answers, moves, options.readOnly]);
}

// ------------------------------------------------------------------------------------------------------- node and edge

/** One bubble on the canvas: the shared look at canvas size, its menu on a click or Enter, and the handle its dashed edge ends on. */
export function BubbleNode({ data }: NodeProps<BubbleFlowNode>) {
  const answer = useBubbleAnswer(data.request);
  const [action, setAction] = useState<BubbleAction>();
  return (
    <div data-bubble-node={data.bubble.id} className="nodrag nopan relative flex w-16 justify-center">
      <Handle id="out" type="source" position={Position.Top} isConnectable={false} className="!-top-1 !size-2.5 !rotate-45 !rounded-[2px] !border-[1.5px] !border-t2 !bg-sf" />
      <Popover
        title={data.bubble.label}
        label={`${data.bubble.label}: menu`}
        align="start"
        trigger={({ open, toggle }) => <BubbleView bubble={data.bubble} agentName={data.agentName} size="canvas" open={open} onOpen={toggle} />}
      >
        {(close) => (
          <BubbleMenu
            agentId={data.request.agentId}
            agentName={data.agentName}
            bubble={data.bubble}
            workflowId={data.request.workflowId}
            usedBy={answer?.usedBy}
            readOnly={data.readOnly}
            version={data.request.version}
            close={close}
            act={setAction}
          />
        )}
      </Popover>
      {action && <BubbleActions agentId={data.request.agentId} agentName={data.agentName} bubble={data.bubble} usedBy={answer?.usedBy} action={action} onDone={() => setAction(undefined)} />}
    </div>
  );
}

/** The dashed sub-node line from a slot to its bubble: straight down through the slot's label column, then curving to the bubble's top. */
export function BubbleEdgeView({ id, sourceX, sourceY, targetX, targetY }: EdgeProps<BubbleFlowEdge>) {
  const drop = Math.min(56, Math.max(0, (sourceY - targetY) * 0.55));
  const mid = targetY + drop + (sourceY - targetY - drop) / 2;
  const path = `M ${targetX} ${targetY} L ${targetX} ${targetY + drop} C ${targetX} ${mid}, ${sourceX} ${mid}, ${sourceX} ${sourceY}`;
  return <BaseEdge id={id} path={path} style={{ stroke: 'var(--t3)', strokeWidth: 1.5, strokeDasharray: '5 4' }} />;
}

// ------------------------------------------------------------------------------------------------------------------ chip

type PublishState = { state: 'idle' } | { state: 'testing' } | { state: 'publishing' } | { state: 'held'; reason?: string; score?: number } | { state: 'failed'; reason: string };

/**
 * The one chip above a bound node, right-aligned like the team ribbon (never inside the card's text): what is not published
 * ("2 changes not published", "Not published") with **Publish**, and for a team's lead "Lead · <name>". Publish runs the draft's
 * smoke test, then the gate (`publishChange`: a hold is an answer, never skipped, no "Publish anyway").
 */
export function AgentChip(props: { agentId: string; nodeId: string; workflowId?: string; lead?: boolean; raised?: boolean; version?: number | 'draft' }) {
  return props.version === undefined ? <DraftChip {...props} /> : <VersionChip {...props} version={props.version} />;
}

/** A version view's chip: which agent version this workflow version or run drew ("Alert triager v1", "Alert triager draft"). Read-only: no Publish. */
function VersionChip({ agentId, nodeId, workflowId, version, raised }: { agentId: string; nodeId: string; workflowId?: string; version: number | 'draft'; raised?: boolean }) {
  const answer = useBubbleAnswer({ agentId, nodeId, ...(workflowId && { workflowId }), ...(typeof version === 'number' && { version }) });
  if (!answer) return null;
  return (
    <div data-testid="agent-chip" data-version={version} className={cn('nodrag nopan absolute right-0 flex max-w-[300px] flex-col items-end gap-1', raised ? '-top-[68px]' : '-top-8')}>
      <div className="flex items-center rounded-full border border-hair bg-sf px-2.5 py-0.5 text-[11px] font-semibold leading-4 text-t1 shadow-sm">
        <span className="truncate">{answer.agent.name} {version === 'draft' ? 'draft' : `v${version}`}</span>
      </div>
    </div>
  );
}

function DraftChip({ agentId, nodeId, workflowId, lead, raised }: { agentId: string; nodeId: string; workflowId?: string; lead?: boolean; raised?: boolean }) {
  const answer = useBubbleAnswer({ agentId, nodeId, ...(workflowId && { workflowId }) });
  const moves = useFlowMoves(workflowId);
  const [publish, setPublish] = useState<PublishState>({ state: 'idle' });
  if (!answer) return null;
  const bubbles = bubblesFromAnswer(answer, moves as AgentMove[], nodeId);
  const pending = pendingLine(bubbles) ?? (answer.agent.draftDiffers ? 'Changes not published' : undefined);
  const unpublished = !answer.agent.published;
  const text = unpublished ? 'Not published' : pending;
  if (!text && !lead) return null;
  const busy = publish.state === 'testing' || publish.state === 'publishing';
  const run = async () => {
    setPublish({ state: 'testing' });
    const smoke = await testDraft(agentId, SMOKE_SAMPLE);
    if (smoke.state !== 'passed') return setPublish({ state: 'failed', reason: smoke.reason ? `The test did not pass: ${smoke.reason}` : 'The test did not pass' });
    setPublish({ state: 'publishing' });
    const result = await publishChange(agentId);
    if (result.state === 'published') {
      setPublish({ state: 'idle' });
      return announceSaved(agentId);
    }
    setPublish(result.state === 'held' ? { state: 'held', ...(result.reason && { reason: result.reason }), ...(result.score !== undefined && { score: result.score }) } : { state: 'failed', reason: result.reason ?? 'Publishing failed' });
  };
  return (
    <div data-testid="agent-chip" className={cn('nodrag nopan absolute right-0 flex max-w-[300px] flex-col items-end gap-1', raised ? '-top-[68px]' : '-top-8')}>
      <div className="flex items-center gap-1.5 rounded-full border border-hair bg-sf py-0.5 pl-2.5 pr-1 text-[11px] leading-4 text-t2 shadow-sm">
        {lead && (
          <span className="truncate font-semibold text-t1">
            Lead · {answer.agent.name}
          </span>
        )}
        {lead && text && <span aria-hidden>·</span>}
        {text && <span className="whitespace-nowrap">{text}</span>}
        {text && (
          <button
            type="button"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              void run();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className="flex min-h-5 items-center gap-1 rounded-full bg-ac px-2 text-[11px] font-semibold text-on-ac disabled:opacity-60 max-md:min-h-9"
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : <UploadCloud className="size-3" />}
            {publish.state === 'testing' ? 'Testing…' : publish.state === 'publishing' ? 'Publishing…' : 'Publish'}
          </button>
        )}
      </div>
      {publish.state === 'held' && (
        <div role="status" className="flex w-max max-w-[260px] flex-col gap-0.5 rounded-xl border border-warnbd bg-sf px-2.5 py-1.5 text-[11.5px] leading-snug text-t1 shadow-pop">
          <span className="font-semibold text-warn">Held by the eval gate{publish.score !== undefined ? ` (${publish.score.toFixed(1)})` : ''}</span>
          {publish.reason && <span className="text-t2">{publish.reason}</span>}
          <a href={`/agents/${encodeURIComponent(agentId)}`} target="_blank" rel="noopener" className="flex items-center gap-1 text-ac underline">
            Open {answer.agent.name} <ExternalLink className="size-3" />
          </a>
        </div>
      )}
      {publish.state === 'failed' && (
        <div role="status" className="w-max max-w-[260px] rounded-xl border border-rdbd bg-sf px-2.5 py-1.5 text-[11.5px] leading-snug text-rd shadow-pop">
          {publish.reason}
        </div>
      )}
    </div>
  );
}

/** What a kept sub-node says about itself: it stays in this flow, why, and what a person may do about it (AG17's record, `kept` rows). */
export function localOf(moves: readonly AgentMove[], subNodeId: string): (LocalOverride & { agentName?: string }) | undefined {
  const row = moves.find((m) => m.subNodeId === subNodeId && m.outcome === 'kept');
  return row && { nodeId: row.subNodeId, name: row.name, slot: row.slot, agentName: row.agentName, why: row.why ?? 'It stays in this flow', ...(row.retry && { retry: true }), ...(row.resolvable && { resolvable: row.resolvable }) };
}

export { agentLink, boundAgentOf };
export type { BubbleAnswer };
