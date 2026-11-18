/**
 * An agent drawn on the canvas as bubbles (wave ag4, the person's ask of 2026-11-18): under a Run an Agent node (and a
 * Run a Team node, for its lead), each of the agent's own model, memory, tools and knowledge bases is a round bubble
 * wired with a dashed sub-node edge to its slot (Chat Model, Memory, Tool), the way a wired sub-node is drawn; nothing
 * about the agent is written inside the node card. The bubbles are the agent: an edit through them changes the saved
 * agent (its draft), so every workflow that runs it changes together.
 *
 * Contract file: backbone/contracts/ag4/agent-bubbles.ts (wave ag4, owner AG16, copied byte for byte by AG17 and AG19),
 * copied to apps/web/src/lib/shared/agent-bubbles.ts. Types and pure helpers only: no import, no zod (the browser loads
 * it), no I/O. Change it here first (the owner only), then copy. The bubble's look is one component,
 * backbone/contracts/ag4/bubble-view.tsx (owner AG16, copied by AG19): the canvas and Spotlight's agent card both draw it.
 *
 * The person's decisions of 2026-11-18, after the mockup ("Yes, build it"):
 * - Bubble edits go live after Publish: an edit changes the agent's draft, every workflow shows it as not published, and
 *   the Publish chip runs the gate (smoke test, eval gate, never `skipEval`).
 * - Old per-flow wiring: "Move them all now". Every model, memory and tool a saved flow wired into a Run an Agent (or Run
 *   a Team) node moves into that agent's DRAFT (never the published version), and the flow is cleaned of it, so the
 *   bubbles take over; a record says what moved where, a notice names each item and the agent's unpublished state, and
 *   production keeps running its published workflow version (its own wiring, its pinned agent version: agent-versions.ts)
 *   until a person publishes again. What can't move stays, keeps working in that flow,
 *   says why and is listed (`AgentMove` with `outcome: 'kept'`). The rules are `KEEP_WHY` and the README's R1–R12.
 * - Spotlight's agent card shows the proposed agent as bubbles too (`cardBubbles`, drawn by bubble-view.tsx's
 *   `BubbleDiagram`).
 *
 * The wire, for reference (each route is its owner's):
 * - `GET /api/agents/:id/connections?workflowId=&nodeId=` (ag3 AG12, extended by AG16, additive): as before
 *   `{ agent: { id, name, published, draftDiffers, icon?, color?, avatar? }, connections }` (the published config, what
 *   a run uses, the Run Trace's source), plus `draft?: ActorConnection[]` when `draftDiffers` (the draft's, from the
 *   same `agentConnections`) and `usedBy?: Array<{ workflowId: string; name: string }>` (the workflows the caller can
 *   read whose Run an Agent / Run a Team node runs this agent; for "used by 2 workflows" before a change).
 * - `POST /api/workflows/:id/agent-moves` (AG17) `{ updatedAt?: string, subNodeIds?: string[], resolve?: Record<string,
 *   'useEverywhere'> }` → 200 `AgentMoveResult`: moves every movable wired sub-node of the workflow's bound nodes (or only
 *   `subNodeIds`) into the agents' drafts and saves the workflow without them, in one step; `resolve` is a person's choice
 *   for a kept item whose `resolvable` is `'useEverywhere'` (a model or a credential that differs from the agent's). 404
 *   for a workflow the caller cannot see, 403 without update access to the workflow (an agent the caller cannot update
 *   is not an error: its items are kept with `KEEP_WHY.access`), the protected-environment guard's refusal as for any
 *   workflow write (`lib/server/environments/protection.ts`; the start pass keeps them with `KEEP_WHY.protectedEnv`), and 412 `workflow_conflict` (the save rule of `PUT /api/workflows/:id`) when `updatedAt` is not the stored one: then
 *   every agent draft it changed is put back and nothing is recorded as moved. `?dryRun=1` answers the same and changes
 *   nothing. The editor calls it on open (AG17); the host's start pass calls the same function for every saved flow.
 * - `GET /api/workflows/:id/agent-moves` (AG17) → `{ moves: AgentMove[] }`: the record of that flow, newest first, each
 *   moved item with its `state` read against the agent now. `GET /api/agents/:id/moves` (AG17) → `{ moves: AgentMove[] }`:
 *   what moved into that agent and from which flows (only flows the caller can read).
 * - Bubble edits use the agent routes that exist: `GET /api/agents/:id` (the draft), `PUT /api/agents/:id` (the draft, as
 *   `lib/client/agent-change.ts` `saveChange` does, with its smoke test), `POST /api/agents/:id/publish` (the gate; never
 *   `skipEval`). Nothing new on the server for them.
 */

/** The slot a bubble hangs under: the Run an Agent node's sub-node ports (`lib/server/nodes/agents.ts`). */
export type BubbleSlot = 'model' | 'memory' | 'tool';

/** The connection type of each slot's handle (`ai_languageModel`, `ai_memory`, `ai_tool`). */
export const SLOT_HANDLE: Record<BubbleSlot, string> = { model: 'ai_languageModel', memory: 'ai_memory', tool: 'ai_tool' };

/**
 * What an agent is connected to, as the bubbles need it: a structural subset of `ActorConnection`
 * (`lib/shared/run-trace.ts`, ag3 AG12) so this file imports nothing.
 */
export interface BubbleSource {
  kind: string; // ActorConnection's: 'model' | 'memory' | 'tool' | 'knowledge' | 'agent' | 'skill' | …
  name: string;
  detail?: string;
  icon?: string;
  nodeType?: string;
  toolId?: string;
  asksFirst?: boolean;
  credential?: string;
  documents?: number;
  overriddenBy?: string;
  withheld?: string;
  from?: string; // 'agent' | 'flow' | 'project' | 'kagent'
}

/** One bubble. `id` is stable for a given agent tool (`tool:<toolId>`), model (`model`) or memory (`memory`). */
export interface Bubble {
  id: string;
  slot: BubbleSlot;
  kind: string;
  /** The big line under the circle: the model's name, "This conversation", the tool's call name, the collection. */
  label: string;
  /** The small line: the provider ("Anthropic"), "Memory", the plugin or app ("Triage"), "4 documents", "asks first". */
  sub?: string;
  icon?: string;
  nodeType?: string;
  toolId?: string;
  asksFirst?: boolean;
  /** The credential's name only (never data), for the hover title; `missing` when the tool needs one and has none. */
  credential?: string | 'missing';
  /**
   * Against the published version (what a run uses): `added` (in the draft only: drawn dashed with a "not published" dot),
   * `changed` (both, different), `removed` (published only: drawn faded and struck until the draft is published).
   */
  pending?: 'added' | 'changed' | 'removed';
  /** Kept from ag3: the name of a wired sub-node that replaces it this run (legacy flows, see `local`). */
  overriddenBy?: string;
  /** The project's rules keep it out of this flow's runs ("the project allows no write tools"). */
  withheld?: string;
  /** The project's default model, not the agent's own. */
  fromProject?: boolean;
  /**
   * Moved into the agent from THIS flow and not published yet (`markMoved`): production still runs the flow's published
   * version with it wired, so the bubble says where it came from instead of looking like an edit nobody made.
   */
  movedHere?: boolean;
}

/**
 * A sub-node still wired into a bound node because it could not move (`AgentMove.outcome === 'kept'`): it stays, keeps
 * working in this flow, and is drawn as the real sub-node it is, tagged "this flow only", with `why`.
 */
export interface LocalOverride {
  /** The wired sub-node's id in the workflow. */
  nodeId: string;
  name: string;
  slot: BubbleSlot;
  why: string;
  /** The reason may pass by itself (a plugin back online, a credential shared, a flow saved meanwhile): moved on a later open or start. */
  retry?: boolean;
  /** A person may choose to move it anyway: "Use <model> for <agent> everywhere" (AG16's tag button, Spotlight's changeAgent). */
  resolvable?: 'useEverywhere';
}

/** One wired sub-node and what happened to it (AG17's record, table `agent_flow_moves`, one row per workflow and sub-node). */
export interface AgentMove {
  workflowId: string;
  workflowName?: string;
  /** The Run an Agent / Run a Team node it was wired into. */
  nodeId: string;
  /** The wired sub-node's id and name as they were in the flow. */
  subNodeId: string;
  name: string;
  slot: BubbleSlot;
  /** For a Run a Team node, the team's lead agent. */
  agentId: string;
  agentName: string;
  /** `moved`: into the agent's draft. `same`: the agent already had it (the sub-node was removed, the agent unchanged). `kept`: stays in the flow. */
  outcome: 'moved' | 'same' | 'kept';
  as?: 'model' | 'tool' | 'knowledge';
  /** The tool's id in the agent's config (moved or same tools), for `markMoved`. */
  agentToolId?: string;
  /** Kept: why (one of `KEEP_WHY`). Moved: a note a person should read (`MOVE_NOTE`), if any. */
  why?: string;
  retry?: boolean;
  resolvable?: 'useEverywhere';
  /** Who moved it: the host's start pass, the editor on open (the person's id), or a person's resolve. */
  by: 'migration' | string;
  at: string;
  /**
   * Read against the agent now (moved items only): `pending` (in the draft, not published),
   * `live` (published: the agent runs it everywhere), `withdrawn` (a person removed it from the draft before publishing).
   */
  state?: 'pending' | 'live' | 'withdrawn';
}

/** What `POST /api/workflows/:id/agent-moves` answers (AG17). */
export interface AgentMoveResult {
  workflowId: string;
  moved: AgentMove[];
  kept: AgentMove[];
  /** Each agent whose draft this call changed (or would change, dry run). */
  agents: Array<{ id: string; name: string; draftDiffers: boolean }>;
  /** The workflow's `updatedAt` after the save (the editor reloads it); absent when nothing moved. */
  updatedAt?: string;
  dryRun?: boolean;
}

/**
 * Why a wired sub-node stays in its flow (AG17 writes these words; the notice, the tag, the record and the tests read them).
 * Each keeps the item working in that flow; none is silent.
 */
export const KEEP_WHY = {
  memory: 'An agent remembers this conversation or across sessions: a memory node can’t move into it',
  modelConflict: (others: string) => `Other workflows that run this agent wire a different model (${others}): pick one for the agent`,
  draftModel: (model: string) => `The agent’s draft already changes its model to ${model}: publish or change that first`,
  credentialConflict: (agents: string, ours: string) => `The agent’s tool uses the credential ${agents}; this flow’s uses ${ours}`,
  credentialAccess: (name: string) => `The credential ${name} isn’t one the agent’s owner may use: share it, or pick one on the agent’s page`,
  pluginOffline: (plugin: string) => `Its plugin (${plugin}) is offline: it moves when the plugin is back`,
  notATool: 'An agent can’t hold this kind of node as a tool',
  access: (agent: string) => `You can’t change ${agent}: someone who can opens this flow, or its owner shares the agent`,
  protectedEnv: 'This is a protected environment: workflows change here only by promotion',
  saved: 'The workflow was saved meanwhile: it moves on the next open',
} as const;

/**
 * The window event the editor dispatches after a move on open or a person's resolve (AG17's `lib/client/agent-moves.ts`);
 * the canvas (AG16) re-reads the flow's moves and the agent's bubbles on it. `detail: { workflowId: string }`.
 */
export const MOVES_CHANGED = 'landflow:agent-moves-changed';

/** Notes on a moved item a person should read (in the notice and the record). */
export const MOVE_NOTE = {
  renamed: (name: string) => `named ${name} in the agent (it already has a different tool by that name)`,
  noAsk: 'doesn’t ask a person first, as it ran here; agents usually ask before writes: say so to add the lock',
  everywhere: (others: number) => `when published it runs in every workflow that runs the agent (${others} other${others === 1 ? '' : 's'})`,
} as const;

/** Marks the bubbles of items moved from this flow and still pending (`Bubble.movedHere`). */
export function markMoved(bubbles: readonly Bubble[], moves: readonly AgentMove[], nodeId: string): Bubble[] {
  const pending = moves.filter((m) => m.nodeId === nodeId && m.outcome === 'moved' && m.state === 'pending');
  return bubbles.map((b) => (pending.some((m) => (m.as === 'model' ? b.slot === 'model' : m.agentToolId !== undefined && b.id === `tool:${m.agentToolId}`)) ? { ...b, movedHere: true } : b));
}

/** The notice's lines after a move (one per item, then the agents' state), in the order a person reads them. */
export function moveNoticeLines(moves: readonly AgentMove[], agents: ReadonlyArray<{ name: string; draftDiffers: boolean }> = []): string[] {
  const what = (m: AgentMove) => `${m.name} (${m.as === 'knowledge' ? 'knowledge base' : m.as ?? m.slot})`;
  const lines: string[] = [];
  for (const m of moves.filter((x) => x.outcome === 'moved')) lines.push(`Moved into ${m.agentName}, not published yet: ${what(m)}${m.why ? `; ${m.why}` : ''}.`);
  for (const m of moves.filter((x) => x.outcome === 'same')) lines.push(`Already in ${m.agentName}: ${m.name} (removed from this flow).`);
  for (const m of moves.filter((x) => x.outcome === 'kept')) lines.push(`Kept in this flow: ${m.name}. ${m.why ?? ''}`.trim());
  for (const a of agents.filter((x) => x.draftDiffers)) lines.push(`${a.name} has changes not published: the editor’s tests use them; publish ${a.name}, then this workflow, to put them live.`);
  return lines;
}

/**
 * The bubbles of an agent Spotlight proposes, before it exists (Spotlight's agent card, AG19; drawn by `BubbleDiagram`).
 * Structural input (the card's fields, `lib/shared/agent-card.ts` ag4) so this file imports nothing.
 */
export function cardBubbles(card: {
  model?: string;
  tools: ReadonlyArray<{ name: string; type?: string; writes: boolean; requireApproval: boolean }>;
  knowledge?: string;
  knowledgeSetup?: { collection: string; fileCount?: number; files?: readonly string[]; state?: string; indexed?: { documents: number } };
  attached?: { collection: string; documents?: number };
  config: Record<string, unknown>;
}): Bubble[] {
  const src: BubbleSource[] = [];
  if (card.model) {
    const slash = card.model.indexOf('/');
    src.push({ kind: 'model', name: slash > 0 ? card.model.slice(slash + 1) : card.model, ...(slash > 0 && { detail: card.model.slice(0, slash) }) });
  }
  const memory = card.config.memory as { crossSession?: boolean } | undefined;
  src.push({ kind: 'memory', name: memory?.crossSession ? 'Across sessions' : 'This conversation', detail: 'Memory' });
  for (const t of card.tools) src.push({ kind: 'tool', name: t.name, ...(t.type && { nodeType: t.type }), ...(t.requireApproval && { asksFirst: true }), ...(t.writes && !t.requireApproval && { detail: 'writes' }) });
  const kb = card.attached ?? (card.knowledgeSetup && { collection: card.knowledgeSetup.collection, documents: card.knowledgeSetup.indexed?.documents ?? card.knowledgeSetup.fileCount }) ?? (card.knowledge ? { collection: card.knowledge } : undefined);
  if (kb) src.push({ kind: 'knowledge', name: kb.collection, ...(typeof kb.documents === 'number' && { documents: kb.documents }) });
  return bubblesOf(src);
}

/**
 * Whether a saved workflow still has sub-nodes wired into a bound node (the editor's open path posts the move only then).
 * Structural input: the workflow's nodes and connections as saved. An id that is an expression (`=…` or `{{ … }}`, the
 * editor's rule; AG17 aligns it with the base's own test if that differs) is not bound.
 */
export function hasWiredOverrides(workflow: {
  nodes: ReadonlyArray<{ id: string; type: string; parameters?: Record<string, unknown> }>;
  connections: ReadonlyArray<{ type: string; target: string }>;
}): boolean {
  const plain = (v: unknown) => typeof v === 'string' && v.trim() !== '' && !v.trim().startsWith('=') && !v.includes('{{');
  const bound = new Set(workflow.nodes.filter((n) => (n.type === 'core.messageAgent' && plain(n.parameters?.agentId)) || (n.type === 'core.runTeam' && plain(n.parameters?.teamId))).map((n) => n.id));
  return workflow.connections.some((c) => (c.type === 'ai_languageModel' || c.type === 'ai_memory' || c.type === 'ai_tool') && bound.has(c.target));
}

/** Canvas geometry the bubbles, Tidy up and Spotlight's placement share (canvas px, the tile's top-left as origin). */
export const BUBBLE = {
  /** The circle's size (a compact sub-node's, `node-tile.tsx`). */
  size: 64,
  /** From the parent's top to the bubbles' top: the slot labels and + buttons (~50 px under an 88 px tile) end above it. */
  below: 200,
  /** Centre to centre, as `SUBNODE_PITCH` (store.ts). */
  pitch: 170,
  /** Label and sub line under a circle. */
  labelHeight: 40,
  /** At most this many bubbles in a row; more wrap to a second row `rowGap` lower. */
  perRow: 6,
  rowGap: 120,
} as const;

/** The order bubbles are drawn in, left to right: model, memory, then tools as the agent lists them (knowledge last). */
export function bubbleOrder(a: Bubble, b: Bubble): number {
  const rank = (x: Bubble) => (x.slot === 'model' ? 0 : x.slot === 'memory' ? 1 : x.kind === 'knowledge' ? 3 : 2);
  return rank(a) - rank(b);
}

/** Bubbles from the published connections and, when the draft differs, the draft's, with each one's pending mark. */
export function bubblesOf(published: readonly BubbleSource[], draft?: readonly BubbleSource[]): Bubble[] {
  const key = (c: BubbleSource) => (c.kind === 'model' ? 'model' : c.kind === 'memory' ? 'memory' : `tool:${c.toolId ?? c.name}`);
  const sig = (c: BubbleSource) => JSON.stringify([c.name, c.detail ?? '', c.nodeType ?? '', Boolean(c.asksFirst), c.credential ?? '', c.documents ?? null]);
  const toBubble = (c: BubbleSource, pending?: Bubble['pending']): Bubble => {
    const slot: BubbleSlot = c.kind === 'model' ? 'model' : c.kind === 'memory' ? 'memory' : 'tool';
    const sub = c.asksFirst ? 'asks first' : c.kind === 'knowledge' && typeof c.documents === 'number' ? `${c.documents} document${c.documents === 1 ? '' : 's'}` : c.detail;
    return {
      id: key(c),
      slot,
      kind: c.kind,
      label: c.name,
      ...(sub && { sub }),
      ...(c.icon && { icon: c.icon }),
      ...(c.nodeType && { nodeType: c.nodeType }),
      ...(c.toolId && { toolId: c.toolId }),
      ...(c.asksFirst && { asksFirst: true }),
      ...(c.credential && { credential: c.credential }),
      ...(pending && { pending }),
      ...(c.overriddenBy && { overriddenBy: c.overriddenBy }),
      ...(c.withheld && { withheld: c.withheld }),
      ...(c.from === 'project' && { fromProject: true }),
    };
  };
  if (!draft) return published.map((c) => toBubble(c)).sort(bubbleOrder);
  const before = new Map(published.map((c) => [key(c), c]));
  const after = new Map(draft.map((c) => [key(c), c]));
  const out: Bubble[] = [];
  for (const c of draft) {
    const old = before.get(key(c));
    out.push(toBubble(c, !old ? 'added' : sig(old) !== sig(c) ? 'changed' : undefined));
  }
  for (const c of published) if (!after.has(key(c))) out.push(toBubble(c, 'removed'));
  return out.sort(bubbleOrder);
}

/**
 * Where the bubbles go, relative to the parent tile's top-left: a row centred under the tile (wrapping after
 * `BUBBLE.perRow`), shifted right past any `occupied` x range (a legacy wired sub-node's) so nothing overlaps: one bubble gap
 * (`BUBBLE.pitch - BUBBLE.size`, so a kept sub-node's label never sits on the first bubble's) from every range, however many
 * there are (the shift repeats until no range is touched). Returns each bubble's top-left.
 */
export function bubblePositions(parentWidth: number, count: number, occupied: ReadonlyArray<{ x: number; width: number }> = []): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  const rows = Math.ceil(count / BUBBLE.perRow);
  const gap = BUBBLE.pitch - BUBBLE.size;
  let shift = 0;
  for (let r = 0; r < rows; r++) {
    const inRow = Math.min(BUBBLE.perRow, count - r * BUBBLE.perRow);
    const rowWidth = (inRow - 1) * BUBBLE.pitch + BUBBLE.size;
    const base = parentWidth / 2 - rowWidth / 2;
    // Past every occupied range this row would touch; later rows keep the same shift.
    for (let again = true; again; ) {
      again = false;
      const left = base + shift;
      for (const o of occupied) {
        if (left < o.x + o.width + gap && left + rowWidth > o.x - gap) {
          shift = o.x + o.width + gap - base;
          again = true;
        }
      }
    }
    const left = base + shift;
    for (let i = 0; i < inRow; i++) out.push({ x: left + i * BUBBLE.pitch, y: BUBBLE.below + r * BUBBLE.rowGap });
  }
  return out;
}

/** The box a bound node keeps clear for its bubbles (relative to its top-left), for Tidy up and Spotlight's placement; `occupied` as `bubblePositions` takes it. */
export function bubbleFootprint(parentWidth: number, count: number, occupied: ReadonlyArray<{ x: number; width: number }> = []): { left: number; right: number; bottom: number } {
  if (count <= 0) return { left: 0, right: parentWidth, bottom: 0 };
  const positions = bubblePositions(parentWidth, count, occupied);
  const left = Math.min(0, ...positions.map((p) => p.x));
  const right = Math.max(parentWidth, ...positions.map((p) => p.x + BUBBLE.size));
  const bottom = Math.max(...positions.map((p) => p.y)) + BUBBLE.size + BUBBLE.labelHeight;
  return { left, right, bottom };
}

/**
 * The count `bubbleFootprint` assumes where the agent is not known (Spotlight's placement in `assistant-ops.ts` is pure
 * and has no agent data): a model, a memory and three tools.
 */
export const ASSUMED_BUBBLES = 5;

/** The hover title of a bubble: what it is, where it is set, and any mark, in words. */
export function bubbleTitle(agentName: string, b: Bubble): string {
  const what = b.slot === 'model' ? `${agentName}’s model` : b.slot === 'memory' ? `${agentName}’s memory` : b.kind === 'knowledge' ? `${agentName}’s knowledge base` : `${agentName}’s tool`;
  const marks = [
    b.asksFirst && 'asks a person before it runs',
    b.credential === 'missing' ? 'needs a credential' : b.credential && `credential ${b.credential}`,
    b.pending === 'added' && 'added, not published yet',
    b.pending === 'changed' && 'changed, not published yet',
    b.pending === 'removed' && 'removed, still runs until published',
    b.movedHere && 'moved here from this flow: publish the agent, then the workflow, to put it live',
    b.overriddenBy && `replaced in this flow by ${b.overriddenBy}`,
    b.withheld,
    b.fromProject && 'the project’s default',
  ].filter(Boolean);
  return `${b.label}: ${what}${marks.length ? ` (${marks.join('; ')})` : ''}`;
}

/** The node's mark when the agent's draft differs from what runs: the chip's text ("2 changes not published"). */
export function pendingLine(bubbles: readonly Bubble[]): string | undefined {
  const n = bubbles.filter((b) => b.pending).length;
  return n ? `${n} change${n === 1 ? '' : 's'} not published` : undefined;
}

/**
 * The words a Run an Agent / Run a Team node's card may hold, besides its own name and type line: none of these. The
 * live check and AG16's test fail when a node card's text contains a model name, a tool's call name or a knowledge base
 * collection of its agent (the person, 2026-11-18: "not with a card that shows the model, knowledge base, and tools").
 */
export function cardLeaks(cardText: string, bubbles: readonly Bubble[]): string[] {
  const text = cardText.toLowerCase();
  return bubbles.map((b) => b.label).filter((label) => label.length > 2 && text.includes(label.toLowerCase()));
}
