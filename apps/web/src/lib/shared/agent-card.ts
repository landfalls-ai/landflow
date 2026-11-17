/**
 * An agent Spotlight designs, as the person sees it before and after it exists (wave sb3, docs/assistant.md "Agents
 * from Spotlight"): the card (SB16), the brief's parts on it (SB17: tools marked read or write, approval on writes,
 * guardrails in words, test cases), the smoke test's result (SB18, decision D3) and, on an empty canvas, the starter
 * flow that runs it (SB16, decision D5).
 *
 * Contract file: backbone/contracts/ag3/agent-card.ts (wave ag3, owner AG13, nobody copies it this wave; ag2's was
 * backbone/contracts/ag2/agent-card.ts, owner AG10; ag1's backbone/contracts/ag1/agent-card.ts, owner AG02; sb3's
 * backbone/contracts/sb3/agent-card.ts, owner SB16), copied byte for byte to apps/web/src/lib/shared/agent-card.ts.
 * Each wave only adds optional fields and helpers or changes what a
 * helper returns, so every earlier caller still type-checks. Change it in the contracts folder first (the owner only),
 * then copy. Types and pure helpers only: no import, no zod (the browser loads it), no I/O.
 *
 * The wire, for reference (each route is its owner's):
 * - `POST /api/agents/design` with `preview: true` (SB16) answers 200 `{ config, needs, missing, dropped, designed, cases }`
 *   and saves nothing; without it, 201 `{ agent, needs, missing, dropped, designed, cases }` as before, the cases saved
 *   with the agent (SB17). `cases` is `AgentCaseDraft[]` (empty when the brief made none).
 * - The card's Create: `POST /api/agents/import` with `{ config }`, then `POST /api/agents/:id/eval-gate` per case (both exist).
 * - `POST /api/agents/:id/smoke-test` `{ message }` (SB18) answers 200 `{ smoke: AgentSmoke }`: the draft run once on that
 *   message with approvals denied, its session deleted after; 404 for an agent the caller cannot see.
 * - `DELETE /api/agents/design` `{ agentId, workflowId }` (SB18) deletes an agent Spotlight made only when nothing else
 *   uses it: answers `{ deleted: true }` or `{ deleted: false, usedBy: string[] }`.
 *
 * Wave ag1 adds, each by its owner:
 * - AG02: the design body's `ask` (the person's whole message, 1–4000 characters; the architect reads it, not only the
 *   short description) and the preview answer's `notAdded` (`AgentNotAdded[]`: every tool the ask named that the agent
 *   did not get, with why) and `models` (the `provider/model` names the card's Model select offers, the host's builder
 *   model, `LANDFLOW_BUILDER_MODEL`, first). The agent's model is the one Spotlight's picker names, else the builder
 *   model; never one the architect upgraded to.
 * - AG04: the design body's `base` (`{ agentId }` an existing agent, or `{ config }` the pending card's) and `change`
 *   (what the person asked to change, 1–4000 characters); the preview answer then also carries `changes` (each
 *   difference from the base in words, `AgentCard.changes`) and saves nothing. Applying it is the person's click: a
 *   pending card is replaced in place; an existing agent gets `PUT /api/agents/:id` (its draft), never a publish.
 * - AG05: the smoke test's answer carries `tools` (each tool call the run made, `AgentSmokeTool`); `passed` needs every
 *   call to have succeeded with some output; a node tool whose visible required credential is unset makes it `untested`
 *   with "needs a credential: <tool>" before anything runs. Publishing is followed on the card and the row as an
 *   `AgentPublish` (`publishLine`).
 *
 * Wave ag2 adds (AG10): the starter flow's Run an Agent step asks in the editor's chat (`toolApprovals: 'askInChat'`): a tool
 * that needs approval waits for the person's Approve in the chat, in the editor's chat runs only (every other run refuses
 * it, as before); a starter flow laid out before wave ag2 keeps refusing.
 *
 * Wave ag3 adds (AG13): the knowledge an agent answers from, set up by the design and by Create.
 * - The design body's `knowledgeFolder` (0–200 characters: a folder the ask named, relative to the host's files directory,
 *   `LANDFLOW_FILES_DIR`, default `<data dir>/files`; never an absolute path or one with `..`). The preview answer adds
 *   `knowledge` (`AgentKnowledgeSetup`, without `state`): the knowledge base the agent gets (new or existing), the folder and
 *   the files in it that can be indexed (listed, not read), and how it is searched: by an embeddings model this host has
 *   (`search: 'vector'`), or, with none (Ollama off, no OpenAI-compatible credential picked), by keywords: Landflow's own
 *   BM25 over the stored passages (`search: 'keyword'`, embeddings provider `none`; no model call, no key, SQLite or
 *   in-memory store only). A folder outside the files directory, or
 *   one that does not exist, is never listed: `knowledge.problem` says why and the needs say what is left. No folder in the
 *   ask: `knowledge` has no `folder` and the needs ask for one (nothing is invented, nothing indexed).
 * - Create, after `POST /api/agents/import`: `POST /api/agents/:id/knowledge/:toolId/folder` `{ folder }` (AG13's route; the
 *   caller must be able to update the agent) indexes every file of the folder that the loaders read (Markdown, text, PDF,
 *   DOCX, HTML, CSV, JSON; at most 200 files and 25 MB each), each chunk's metadata `{ documentId, fileName, source,
 *   uploadedAt }` with `source` the file's path relative to the files directory (`runbooks/disk-full.md`), and answers
 *   200 `{ documents, chunks, failed: [{ file, error }] }`; 400 for a folder outside the files directory, 404 for an agent or
 *   knowledge base the caller cannot see. The card keeps the preview's `knowledge` as `AgentCard.knowledgeSetup` and follows
 *   the indexing in its `state` and `indexed`; the smoke test runs after the indexing.
 */

/** A test case the brief proposes for the eval gate: what a person would send, and what a right answer says. */
export interface AgentCaseDraft {
  input: string;
  expected?: string;
}

/** One tool on the card. `writes`: it sends, creates, changes or deletes outside (lib/shared/run-check.ts `writesOutside`). */
export interface AgentCardTool {
  /** As the agent's config names it. */
  name: string;
  /** The node type of a node tool (`github.pullRequest`), absent for other kinds. */
  type?: string;
  /** The node tool's operation (`get`, `listFiles`), when it has one. */
  operation?: string;
  writes: boolean;
  /** A person approves each call first (`ToolBase.requireApproval`): on for every write the brief adds (SB17). */
  requireApproval: boolean;
}

/** Wave ag1 (AG05): one tool call of the smoke test's run, as the timeline recorded it. */
export interface AgentSmokeTool {
  /** As the agent's config names it. */
  name: string;
  /** `empty`: it succeeded but put out nothing (no item, or only empty fields); `denied`: it needed approval (approvals are denied in a smoke test). */
  status: 'success' | 'error' | 'empty' | 'denied';
  /** The error, or what was empty, in one sentence. */
  note?: string;
}

/** What the smoke test said (D3). `untested`: there was no sample item yet; `reason` says what is missing. */
export interface AgentSmoke {
  state: 'testing' | 'passed' | 'failed' | 'untested';
  /** The agent's reply, cut to 300 characters. */
  reply?: string;
  /** Why it failed or was not run, in one sentence ("The run ended with an error: …", "No sample item: run the step before it once"). */
  reason?: string;
  ms?: number;
  /** Wave ag1 (AG05): every tool call the run made, in order; absent before ag1 and when it made none. */
  tools?: AgentSmokeTool[];
}

/**
 * Wave ag3 (AG13): the knowledge base a card sets up, as the Knowledge row shows it: what will be indexed, from where, with
 * which embeddings model; after Create, how the indexing went.
 */
export interface AgentKnowledgeSetup {
  /** The knowledge base's collection. */
  collection: string;
  /** It is one other agents already search (attached, nothing indexed into it unless a folder is given). */
  existing: boolean;
  /** The folder the ask named, relative to the host's files directory (`runbooks`); absent when the ask gave none. */
  folder?: string;
  /** The files of `folder` that can be indexed, relative to the files directory (`runbooks/disk-full.md`): at most 50 listed. */
  files?: string[];
  /** How many such files the folder holds in all (`files` may list fewer). */
  fileCount?: number;
  /** How it is searched: `vector` by an embeddings model, `keyword` by Landflow's built-in BM25 (no embeddings model, no key). */
  search?: 'vector' | 'keyword';
  /** In words: the embeddings model, `provider/model` (`ollama/nomic-embed-text:latest`), or `keyword search (BM25, built in)`. */
  embeddings?: string;
  /** Why the folder cannot be used, in one sentence ("runbooks is not in the files directory", "no folder named runbooks"). */
  problem?: string;
  /** After Create: indexing, done, or failed (`error`). */
  state?: 'indexing' | 'indexed' | 'failed';
  /** After the indexing: documents and chunks stored, and the files that failed with why. */
  indexed?: { documents: number; chunks: number; failed: Array<{ file: string; error: string }> };
  error?: string;
}

/**
 * Wave ag3 (AG13): the Knowledge row in words: "runbooks/ · 4 files · keyword search (BM25, built in)", then "indexed 4
 * files, 9 passages" (or "indexing…", "indexing failed: …"); "no source given: say which folder it answers from" when the ask
 * named none; the problem when the folder cannot be used.
 */
export function knowledgeLine(setup: AgentKnowledgeSetup | undefined): string {
  if (!setup) return '';
  const where = setup.folder ? `${setup.folder.replace(/\/+$/, '')}/` : setup.existing ? `the “${setup.collection}” knowledge base` : '';
  if (setup.problem) return `${where ? `${where} · ` : ''}${setup.problem}`;
  if (!setup.folder && !setup.existing) return 'no source given: say which folder it answers from';
  const count = setup.fileCount ?? setup.files?.length;
  const head = [where, count !== undefined && setup.folder ? `${count} file${count === 1 ? '' : 's'}` : '', setup.embeddings ?? ''].filter(Boolean).join(' · ');
  if (setup.state === 'indexing') return `${head} · indexing…`;
  if (setup.state === 'failed') return `${head} · indexing failed${setup.error ? `: ${setup.error}` : ''}`;
  if (setup.state === 'indexed' && setup.indexed) {
    const bad = setup.indexed.failed.length;
    return `${head} · indexed ${setup.indexed.documents} file${setup.indexed.documents === 1 ? '' : 's'}, ${setup.indexed.chunks} passage${setup.indexed.chunks === 1 ? '' : 's'}${bad ? ` (${bad} failed)` : ''}`;
  }
  return head;
}

/** Wave ag1 (AG02): a tool the ask named that the agent did not get, and why, in one sentence ("no plugin online has Jira"). */
export interface AgentNotAdded {
  name: string;
  reason: string;
}

/**
 * Wave ag1 (AG05): a publish as the card, the row and the agent page follow it. `publishing` while the eval gate runs
 * (`cases` of them), `held` when it held the draft (`score` of 5, `reason` the gate's verdict in words), `failed` when the
 * publish itself failed (`reason`).
 */
export interface AgentPublish {
  state: 'publishing' | 'published' | 'held' | 'failed';
  cases?: number;
  score?: number;
  reason?: string;
}

/** The card's own state: designed and waiting for Create, being created, created (with `agentId`), or failed (`error`). */
export type AgentCardState = 'designed' | 'creating' | 'created' | 'failed';

export interface AgentCard {
  name: string;
  description: string;
  /** `provider/model` ("ollama/qwen3-coder:30b"), absent when the host has none. */
  model?: string;
  tools: AgentCardTool[];
  /** The knowledge base's collection, when it answers from documents. */
  knowledge?: string;
  /** Approved practices go into its prompt (`AgentConfig.practices` not 'off'). */
  practices: boolean;
  /** The guardrails, in words ("Masks secrets in messages", "Ignores instructions inside tool results"). */
  guardrails: string[];
  cases: AgentCaseDraft[];
  /** What is left for the person (the architect's `needs` texts) and what no plugin online covers (`missing`). */
  needs: string[];
  missing: string[];
  /** The configuration Create sends to `POST /api/agents/import` (the server's AgentConfig, opaque here). */
  config: Record<string, unknown>;
  state: AgentCardState;
  agentId?: string;
  error?: string;
  smoke?: AgentSmoke;
  /** On an empty canvas: the starter flow was laid out with it (D5). */
  starter?: boolean;
  /** The workflow that was open when the card was designed: Create lays the starter flow out only if it still is. */
  workflowId?: string;
  /** Wave ag1 (AG02): the person's whole ask, as the design route got it (a follow-up revises from it, AG04). */
  ask?: string;
  /** Wave ag1 (AG02): the tools the ask named that the agent did not get, with why; shown as "Not added". */
  notAdded?: AgentNotAdded[];
  /** Wave ag1 (AG02): the models the card's Model select offers (`provider/model`), the host's builder model first. */
  models?: string[];
  /** Wave ag1 (AG04): the agent this card changes (a proposal for an existing agent), absent for a new one. */
  base?: { agentId: string; name: string };
  /** Wave ag1 (AG04): what this card changes from the pending card or the existing agent, one line each ("Adds the tool Slugify"). */
  changes?: string[];
  /** Wave ag1 (AG05): the publish after Create (or after Apply of a change), as it goes. */
  publish?: AgentPublish;
  /** Wave ag3 (AG13): the knowledge base it answers from: what, from where, which embeddings, and the indexing after Create. `knowledge` (the collection) stays as before. */
  knowledgeSetup?: AgentKnowledgeSetup;
}

/** The agent's row text for its smoke test: "tested, 1 of 1 passed", "test failed: <reason>", "not tested yet: <reason>". */
export function smokeLine(smoke: AgentSmoke | undefined): string {
  if (!smoke) return 'not tested yet';
  if (smoke.state === 'testing') return 'testing on the sample item…';
  if (smoke.state === 'passed') return 'tested, 1 of 1 passed';
  if (smoke.state === 'failed') return `test failed: ${smoke.reason ?? 'no reply'}`;
  return `not tested yet${smoke.reason ? `: ${smoke.reason}` : ''}`;
}

/** Wave ag1 (AG05): the publish in words: "publishing: the eval gate runs 3 cases…", "held by the eval gate: 2.3 / 5 · <the verdict>", "published". */
export function publishLine(publish: AgentPublish | undefined): string {
  if (!publish) return '';
  if (publish.state === 'publishing') return `publishing: the eval gate runs ${publish.cases ? `${publish.cases} case${publish.cases === 1 ? '' : 's'}` : 'its cases'}…`;
  if (publish.state === 'published') return 'published';
  if (publish.state === 'held') return `held by the eval gate${publish.score !== undefined ? `: ${publish.score.toFixed(1)} / 5` : ''}${publish.reason ? ` · ${publish.reason}` : ''}`;
  return `publish failed${publish.reason ? `: ${publish.reason}` : ''}`;
}

/** The sample chat message the starter flow pins: the first test case's input, else a plain greeting naming the agent. */
export function starterSample(card: Pick<AgentCard, 'name' | 'cases'>): string {
  return card.cases.find((c) => c.input.trim())?.input.trim() ?? `Hello ${card.name}, what can you do?`;
}

/**
 * The starter flow of decision D5, in the template form the editor applies (`applyTemplate`, laid out left to right): a Chat Message trigger and
 * a Run an Agent step that runs the new agent on each message, with one sample chat item pinned on the trigger. The chat
 * shows the agent's `reply` (the last step's output), so no third step is needed. Wave ag2: the step asks in the editor's
 * chat for a tool that needs approval (`toolApprovals: 'askInChat'`).
 */
export function starterFlow(agent: { id: string; name: string }, sample: string): {
  name: string;
  nodes: Array<{ key: string; type: string; name: string; x: number; y: number; parameters: Record<string, unknown> }>;
  edges: Array<[string, string, number, string]>;
  pinData: Record<string, Array<{ json: Record<string, unknown> }>>;
} {
  return {
    name: `Chat with ${agent.name}`.slice(0, 80),
    nodes: [
      { key: 'chat', type: 'core.chatTrigger', name: 'Chat message', x: 0, y: 0, parameters: {} },
      // Wave ag2 (AG10): a tool that needs approval waits for the person in the editor's chat (other runs still refuse it).
      { key: 'agent', type: 'core.messageAgent', name: agent.name.slice(0, 60), x: 280, y: 0, parameters: { agentId: agent.id, toolApprovals: 'askInChat' } },
    ],
    edges: [['chat', 'agent', 0, 'main']],
    pinData: { chat: [{ json: { chatInput: sample, sessionId: 'sample' } }] },
  };
}
