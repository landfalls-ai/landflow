/**
 * Workflow versions pin agent versions (wave ag4, the person's requirement of 2026-11-18, final): "a workflow in version 1
 * will have an agent in version 2 … each time we publish, we save a new version of a workflow and set a version to
 * production … executions are also related to a specific version." Their choice when an agent publishes a newer version
 * than a production workflow was published with: **keep it until republish**. Publishing a workflow pins the exact agent
 * version of each Run an Agent / Run a Team node; production runs that version until a person (or Spotlight, on their
 * confirm) publishes a new workflow version with the newer one; every run records both versions.
 *
 * Contract file: backbone/contracts/ag4/agent-versions.ts (wave ag4, owner AG21, copied byte for byte by AG16 and AG17),
 * copied to apps/web/src/lib/shared/agent-versions.ts. Types and pure helpers only: no import, no zod, no I/O.
 *
 * What exists on 797eafd8 (read, not changed here): `workflow_versions` (every save is a version, numbered per workflow),
 * `workflow_publications` (the version production triggers run), `workflow_publish_log`, `executions.version_id`;
 * `lib/server/publish.ts` (`productionWorkflow` serves the published version's snapshot, `publishVersion`, `publishDraft`;
 * publishing an older version is a rollback); an agent's `published: AgentVersion` and `history: AgentVersion[]` (newest
 * first, at most 20; each holds the full `AgentConfig`); `configFor(agent, version)` (`lib/server/agents/runtime.ts`).
 *
 * The wire (AG21's routes; additive):
 * - `POST /api/workflows/:id/publish` (exists): before publishing it pins each bound node's agent at its **published**
 *   version. An agent whose draft differs from its published version (or that was never published) → 409
 *   `agent_changes_unpublished` `{ agents: PinBlock[] }` and nothing is published, unless the body says
 *   `agents: 'publish-first'` (each such agent's smoke test, then its gate, D3; then the workflow publishes pinning the
 *   new versions; a hold or a failed smoke publishes nothing and answers 409 with the verdict) or `agents: 'as-published'`
 *   (pin the published versions knowingly; the publish log says "not the agent drafts the editor tested"). When the
 *   version to publish already has pins that differ (the same graph, an older agent), a new version is recorded (the same
 *   graph, the next number, summary `pinsSummary`) and that one is published: a version always means one graph and one set
 *   of agent versions. Publishing an older version by id (a rollback) runs its own pins, unchanged.
 * - `POST /api/workflows/:id/publish` with `{ update: { agents: string[] }, testedExecutionId?: string }`: a new version
 *   from the **production** version's graph with the named agents re-pinned to their latest published versions, published;
 *   the draft is not touched (the "Agent vN available" path).
 * - `POST /api/workflows/:id/test-update` `{ agents: string[] }` → `{ executionId, status }`: a manual run of the production
 *   version's graph with the named agents at their latest published versions (the trigger's data replayed from the last
 *   production run, else the trigger's pinned test data, else 409 `no_input`); recorded like any run (both versions).
 * - `GET /api/workflows/:id/agent-updates` → `{ updates: AgentUpdate[] }`; `GET /api/workflows/:id/versions/:versionId/pins`
 *   → `{ pins: AgentPin[] }`; `GET /api/agents/:id/versions` → `{ versions: AgentVersionUse[] }`;
 *   `GET /api/agents/:id/versions/:version/connections` → `{ agent, version, connections }` (as the connections route,
 *   for that version's config: the bubbles of a version view, read-only).
 * - The executions routes add `versions: RunVersions` to an execution's answer (from `executions.version_id` and the new
 *   `execution_agent_versions` rows).
 */

/** One bound node's pinned agent in a workflow version (table `workflow_version_pins`). A Run a Team node pins every agent it runs (its lead first). */
export interface AgentPin {
  nodeId: string;
  nodeName?: string;
  agentId: string;
  agentName?: string;
  version: number;
}

/** Why a publish stopped: an agent whose draft is not what is published. */
export interface PinBlock {
  agentId: string;
  name: string;
  /** The published version, absent when never published. */
  published?: number;
  /** The draft's changes against it, in words (the agent page's diff labels), at most 5. */
  changes: string[];
}

/**
 * The internal node parameter the production copy of a published version carries on each bound Run an Agent node (its
 * pin; a Run a Team node carries `PINS_PARAM`: agent id → version). Never saved in the workflow, never shown in the panel.
 */
export const PIN_PARAM = 'agentVersion';
export const PINS_PARAM = 'agentVersions';

/** Which agent config a run of a bound node uses. */
export type RunSource = 'pinned' | 'draft' | 'published';

/**
 * The rule (AG21 applies it in `lib/server/nodes/agents.ts`; AG17 reads it for its overlay):
 * - a run of a published workflow version (the production copy carries each node's pin) → `pinned`;
 * - a run the editor starts (a manual run, the editor's chat, Spotlight's test runs) → `draft` (the agent's draft: what
 *   the bubbles in the editor show, where bubble edits and AG17's moves land);
 * - anything else (a never-published workflow called as a sub-workflow, a version with no pin) → `published`, as before.
 */
export function runSource(pinnedVersion: number | undefined, editorRun: boolean): RunSource {
  if (typeof pinnedVersion === 'number') return 'pinned';
  return editorRun ? 'draft' : 'published';
}

/** Whether a run is one the editor started: a manual run, or the editor's chat (mode `chat` with a wait the editor can resume). */
export function isEditorRun(mode: string | undefined, canWaitInEditor: boolean): boolean {
  return mode === 'manual' || (mode === 'chat' && canWaitInEditor);
}

/** The agent a run used at one node (table `execution_agent_versions`). */
export interface RunAgentVersion {
  nodeId: string;
  nodeName?: string;
  agentId: string;
  agentName: string;
  /** The published version number, or `draft`. */
  version: number | 'draft';
  source: RunSource;
}

/** Both versions of a run. */
export interface RunVersions {
  workflow: { versionId?: string; number?: number; production: boolean };
  agents: RunAgentVersion[];
}

/** The Run Trace's and the executions list's line: "workflow v4 · Alert triager v2"; a test of the draft "workflow draft (v5) · Alert triager draft". */
export function runVersionsLine(v: RunVersions): string {
  const wf = v.workflow.number === undefined ? 'workflow' : v.workflow.production ? `workflow v${v.workflow.number}` : `workflow draft (v${v.workflow.number})`;
  const seen = new Set<string>();
  const agents = v.agents.filter((a) => !seen.has(`${a.agentId}:${a.version}`) && seen.add(`${a.agentId}:${a.version}`)).map((a) => `${a.agentName} ${a.version === 'draft' ? 'draft' : `v${a.version}`}`);
  return [wf, ...agents].join(' · ');
}

/** A production workflow that pins an older agent version than the agent's published one. */
export interface AgentUpdate {
  workflowId: string;
  workflowName: string;
  /** The production version's number. */
  workflowVersion: number;
  agentId: string;
  agentName: string;
  pinned: number;
  latest: number;
  /** The nodes that run it. */
  nodes: string[];
}

/** The editor's and Spotlight's notice: "Alert triager v3 is available". */
export function availableLine(u: Pick<AgentUpdate, 'agentName' | 'latest' | 'pinned'>): string {
  return `${u.agentName} v${u.latest} is available (production runs v${u.pinned})`;
}

/** The new version's summary when only pins change: "Alert triager v1 → v2". */
export function pinsSummary(changes: ReadonlyArray<{ agentName: string; from?: number; to: number }>): string {
  return changes.map((c) => `${c.agentName} ${c.from === undefined ? '' : `v${c.from} → `}v${c.to}`).join(', ');
}

/** Whether two pin sets differ (by node and agent). */
export function pinsDiffer(a: readonly AgentPin[], b: readonly AgentPin[]): boolean {
  const key = (p: AgentPin) => `${p.nodeId}:${p.agentId}:${p.version}`;
  const x = new Set(a.map(key));
  return a.length !== b.length || b.some((p) => !x.has(key(p)));
}

/**
 * Spotlight's publish card (AG21's `propose_publish` and `propose_agent_update` emit it as the ChatEvent
 * `{ type: 'publishOffer'; offer: PublishOffer }`). `draft`: publish the editor's draft, pinning `pins` (with `blocks`, the
 * card offers **Publish <agent> first**, or **Publish with <agent> vN as published**, never by itself). `update`: a new
 * version from the production graph with `updates` re-pinned; **Test** first (`test-update`), then **Publish** enabled
 * only after a passing test. Nothing publishes without the person's click on the card.
 */
export interface PublishOffer {
  workflowId: string;
  kind: 'draft' | 'update';
  /** The number the published version will have (a new version is recorded when needed: V3). */
  nextVersion: number;
  /** What the version will run. */
  pins: AgentPin[];
  updates?: AgentUpdate[];
  blocks?: PinBlock[];
}

/** The card's title: "Publish v7: runs Alert triager v1"; an update "Publish v9: Alert triager v1 → v2 (test first)". */
export function publishOfferLine(o: PublishOffer): string {
  if (o.kind === 'update' && o.updates?.length) {
    return `Publish v${o.nextVersion}: ${pinsSummary(o.updates.map((u) => ({ agentName: u.agentName, from: u.pinned, to: u.latest })))} (test first)`;
  }
  const seen = new Set<string>();
  const runs = o.pins.filter((p) => !seen.has(p.agentId) && seen.add(p.agentId)).map((p) => `${p.agentName ?? p.agentId} v${p.version}`);
  return `Publish v${o.nextVersion}${runs.length ? `: runs ${runs.join(', ')}` : ''}`;
}

/** One published agent version and the workflow versions that pin it (the agent page's versions view). */
export interface AgentVersionUse {
  version: number;
  publishedAt: string;
  publishedBy?: string;
  /** The person's name, when the list route knows it. */
  publishedByName?: string;
  usedBy: Array<{ workflowId: string; name: string; workflowVersion: number; production: boolean }>;
}

/** The versions view's line: "v2 · used by Alert intake v4 (production), Alert intake v3". */
export function usedByLine(v: AgentVersionUse): string {
  if (!v.usedBy.length) return `v${v.version} · no workflow pins it`;
  return `v${v.version} · used by ${v.usedBy.map((u) => `${u.name} v${u.workflowVersion}${u.production ? ' (production)' : ''}`).join(', ')}`;
}
