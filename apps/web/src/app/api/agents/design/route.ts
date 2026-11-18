/**
 * POST { name, description, instructions, workflow?, after?, before?, tools?, knowledge? } — the agent Spotlight proposes (`newAgent`,
 * docs/assistant.md#agents-and-teams), designed by the Agent architect: a model this host has (a local one first), the
 * tools it needs from the plugins online and a knowledge base when it works from documents. Saved as a draft; the
 * editor publishes it in autonomous mode. Its brief's test cases are saved on it (the eval gate). Answers `{ agent, needs, missing, dropped, designed, cases }`, or 429 with the cap's
 * message when the caller's AI usage cap is reached (no agent is created).
 * SB16: with `preview: true` the design is answered, not saved: 200 `{ config, needs, missing, dropped, designed, cases }`
 * (Spotlight's agent card shows it; Create then imports the config).
 * AG02: both answers add `notAdded` (the tools the ask named that the agent did not get, with why) and `models` (the `provider/model` names a
 * card's Model select offers, the builder model first); the body's `ask` is the person's whole message.
 * AG19: the preview answer adds `reuse` (an existing agent that already does the job), `attached` (an existing knowledge base searched as it is), `modelWhy`, `modelNote` and `catalog` (what the design read of the tenant); the body accepts `agentModel`, `knowledgeBase` and `toolNodes` (Spotlight's hints).
 * AG04: with `preview: true`, `base` (`{ agentId }` of an agent the caller can edit, or `{ config }` of a pending card) and `change`
 * (what to change, in words) the answer is the changed config and `changes` (what differs from the base, one line each); nothing
 * is saved. `base` without `change` (or the reverse) or without `preview` is 400; an agent the caller cannot edit is 404.
 */
import { z } from 'zod';
import { randomFace } from '@/lib/shared/faces';
import { agentResources } from '@/lib/server/assistant/agent-resources';
import { designAgent } from '@/lib/server/assistant/architect';
import { withKnowledgeSetup } from '@/lib/server/assistant/knowledge-setup'; // AG13:
import { listKnowledgeDocuments } from '@/lib/server/agents/knowledge'; // AG19:
import type { VectorKnowledgeBaseConfig } from '@/lib/shared/agents'; // AG19:
import { resolveSpotlightModel } from '@/lib/server/assistant/models-list'; // SB19:
import { allowedTypes } from '@/lib/server/assistant/scope';
import { addCase, listCases } from '@/lib/server/agents/eval-gate'; // SB17:
import { agentUsedBy, removeAgent } from '@/lib/server/agents/remove'; // SB18:
import { agentStore, configOf } from '@/lib/server/agents/store';
import { agentChanges } from '@/lib/shared/agent-changes'; // AG04:
import { tidyChangedTools } from '@/lib/server/agents/change-tools';
import { expectsOnlyDenial, lookupCases, reconcileLookup } from '@/lib/server/agents/change-lookup';
import type { AgentConfig } from '@/lib/shared/agents'; // AG04:
import { isUsageCapError } from '@/lib/server/ai-usage';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { canResource } from '@/lib/server/projects/access'; // SB18:
import { createInProject, routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

const Body = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(''),
  instructions: z.string().max(4000).default(''),
  workflow: z.string().max(200).optional(),
  after: z.string().max(200).optional(),
  before: z.string().max(200).optional(),
  // SB05: what the agent needs, from Spotlight's newAgent.
  tools: z.array(z.string().max(80)).max(8).optional(),
  knowledge: z.string().max(200).optional(),
  // AG13: a folder the ask named, relative to the files directory: the knowledge base is indexed from it when Create runs.
  knowledgeFolder: z.string().trim().max(200).optional(),
  knowledgeAsked: z.boolean().optional(), // AG13: the ask or change wanted a source (a knowledge clause named the folder)
  // SB19: the model Spotlight picked (a model this server offers); absent, the Settings default.
  model: z.string().max(100).optional(),
  // AG02: the person's whole message: the architect reads it, not only the short description.
  ask: z.string().trim().min(1).max(4000).optional(),
  typedAsk: z.string().trim().max(4000).optional(),
  // SB16: answer the design without saving an agent (Spotlight's agent card).
  preview: z.boolean().optional(),
  // AG04: a change to an agent that exists (`agentId`) or to a pending card (`config`): both or neither, and only as a preview.
  base: z.union([z.object({ agentId: z.string().min(1).max(200) }), z.object({ config: z.record(z.string(), z.unknown()) })]).optional(),
  change: z.string().trim().min(1).max(4000).optional(),
  // AG19: Spotlight's hints (`newAgent`): a model from list_models (`provider/model`), an existing knowledge base's collection, the node types it found.
  agentModel: z.string().trim().max(100).optional(),
  knowledgeBase: z.string().trim().max(200).optional(),
  toolNodes: z.array(z.object({ nodeType: z.string().trim().min(1).max(120), operation: z.string().trim().max(80).optional() })).max(8).optional(),
});

const shortInput = (input: string) => `“${input.length > 70 ? `${input.slice(0, 69)}…` : input}”`;

export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  // AG04: `base` and `change` come together and only answer a preview; an agent the caller cannot edit is not found.
  const { base, change } = parsed.data;
  if (Boolean(base) !== Boolean(change)) return error('Send both base and change, or neither', 400);
  if (base && !parsed.data.preview) return error('A change is only designed as a preview: set preview to true', 400);
  let baseConfig: Record<string, unknown> | undefined;
  if (base && 'agentId' in base) {
    const current = agentStore.get(base.agentId);
    if (!current || !canResource(routeActor(), 'agent', base.agentId, 'update')) return error('Agent not found', 404);
    baseConfig = configOf(current) as unknown as Record<string, unknown>;
  } else if (base) baseConfig = base.config;
  // A change to a saved agent: its test cases go to the design, which names the ones the change makes wrong.
  const existingCases = base && 'agentId' in base ? listCases(base.agentId).map((c) => ({ id: c.id, input: c.input, ...(c.expected && { expected: c.expected }) })) : [];
  const picked = await resolveSpotlightModel(parsed.data.model); // SB19:
  if ('error' in picked) return error(picked.error, 400); // SB19:
  const actor = routeActor();
  const resources = await agentResources(actor);
  let design: Awaited<ReturnType<typeof designAgent>>;
  try {
    design = await designAgent({ ...parsed.data, base: baseConfig as Partial<AgentConfig> | undefined /* AG04: */, ...(existingCases.length && { cases: existingCases }) }, { model: picked.model, types: allowedTypes(undefined, actor), actor, resources, signal: request.signal });
  } catch (caught) {
    // The caller's AI usage cap: say so, and create no agent (Spotlight shows the message on the step).
    if (isUsageCapError(caught)) return error(caught.message, 429);
    throw caught;
  }
  // AG13: a folder the ask named becomes the knowledge base's source; no folder (and nothing that fits) is asked, never invented.
  const setup = await withKnowledgeSetup(design, { ...(parsed.data.knowledgeFolder && { folder: parsed.data.knowledgeFolder }), ...(parsed.data.knowledge && { knowledge: parsed.data.knowledge }), spotlight: true, ...(parsed.data.knowledgeAsked && { sourceAsked: true }), revise: Boolean(baseConfig), resources });
  design.config = setup.config;
  design.needs = setup.needs;
  // AG19: an existing knowledge base the agent searches as it is: nothing indexed again; its documents are counted for the card.
  let attached: { collection: string; documents?: number; search: string } | undefined;
  if (!baseConfig && setup.knowledge?.existing && !setup.knowledge.folder && setup.knowledge.collection) {
    const tool = design.config.tools?.find((t): t is VectorKnowledgeBaseConfig => t.type === 'knowledge' && 'collection' in t && t.collection === setup.knowledge!.collection);
    const documents = tool && tool.store === 'sqlite' ? await listKnowledgeDocuments(tool).then((d) => d.documents.length).catch(() => undefined) : undefined;
    attached = { collection: setup.knowledge.collection, ...(documents !== undefined && { documents }), search: setup.knowledge.search === 'keyword' ? 'keyword' : (setup.knowledge.embeddings ?? 'vector') };
  }
  const reasoned = design.extras && !baseConfig ? { ...(design.extras.reuse && { reuse: design.extras.reuse }), ...(attached && { attached }), ...(design.extras.modelWhy && { modelWhy: design.extras.modelWhy }), ...(design.extras.modelNote && { modelNote: design.extras.modelNote }), ...(design.extras.catalog.length && { catalog: design.extras.catalog }) } : {}; // AG19:
  const models = resources.models.map((m) => `${m.provider}/${m.model}`); // AG02: the card's Model select, the builder model first
  if (baseConfig && design.config) {
    // Re-check 3/4/5: a new tool joins an incomplete one of its type or stands as its own; the needs (the Left rows) are worked out after, so none names a merged tool.
    const tidy = tidyChangedTools(baseConfig as { tools?: unknown }, design.config as { tools?: unknown });
    design.config = tidy.config as typeof design.config;
    if (tidy.removed.length) design.needs = design.needs.filter((n) => !tidy.removed.includes(String(n.tool)) && !tidy.removed.some((r) => n.text.startsWith(`${r}:`)));
  }
  // The cases a change makes wrong are replaced, by id: the ones the design names (it was given the cases with their ids), and, when a
  // denial of lookups was removed, any whose expected answer is nothing but that denial. Nothing else is guessed at.
  let lookup: ReturnType<typeof reconcileLookup> | undefined;
  let replaceCases: Array<{ id: string; input: string }> = [];
  let newCases: Array<{ input: string; expected: string }> = [];
  let maybeWrong: Array<{ id: string; input: string }> = [];
  if (baseConfig && design.config) {
    lookup = reconcileLookup(baseConfig as never, design.config as never);
    design.config = lookup.config as typeof design.config;
    if (existingCases.length) {
      const named = (design.contradicted ?? []).filter((id) => existingCases.some((c) => c.id === id));
      const denied = lookup.removed ? existingCases.filter((c) => expectsOnlyDenial(c.expected)).map((c) => c.id) : [];
      replaceCases = [...new Set([...named, ...denied])].map((id) => ({ id, input: existingCases.find((c) => c.id === id)!.input }));
      const named_ = replaceCases;
      if (replaceCases.length) {
        const written = named.length ? (design.cases ?? []).filter((c) => c.expected).slice(0, 3).map((c) => ({ input: c.input, expected: c.expected as string })) : [];
        newCases = written.length ? written : lookup.removed ? lookupCases(lookup.tools, (design.config.tools ?? []).some((t) => t.type === 'node')) : [];
        // Nothing to put in their place: Apply would only remove cases (and an agent with none skips the publish gate), so none is replaced; the card says which may now be wrong.
        if (!newCases.length) {
          maybeWrong = named_;
          replaceCases = [];
        }
      }
    }
  }
  const config = baseConfig ? design.config : { avatar: { kind: 'face' as const, face: randomFace(parsed.data.name) }, ...design.config }; // AG04: a change keeps the base's own look
  if (parsed.data.preview) {
    // SB16: the card's preview: a face to show, nothing saved; SB17's brief's cases come with it.
    // AG04: a change also says what it changes from the base; nothing is saved.
    if (baseConfig) return json({ config, changes: [...agentChanges(baseConfig, config as Record<string, unknown>), ...(lookup?.lines ?? []), ...replaceCases.map((c) => `Test removed: ${shortInput(c.input)}`), ...newCases.map((c) => `Test added: ${shortInput(c.input)}`), ...maybeWrong.map((c) => `Test may now be wrong: ${shortInput(c.input)}`)], needs: design.needs, missing: design.missing, dropped: design.dropped, designed: design.designed, cases: newCases, ...(replaceCases.length && { replaceCases }), notAdded: design.notAdded, models /* AG02: */, ...(setup.knowledge && { knowledge: setup.knowledge }) /* AG13: */, ...(design.failure && { failure: design.failure }) });
    return json({ config, needs: design.needs, missing: design.missing, dropped: design.dropped, designed: design.designed, cases: design.cases ?? [], notAdded: design.notAdded, models /* AG02: */, ...(setup.knowledge && { knowledge: setup.knowledge }) /* AG13: */, ...reasoned /* AG19: */ });
  }
  const agent = createInProject(request, 'agent', () => agentStore.create(config), (a) => a.id);
  // SB17: the brief's test cases are saved on the new agent (the eval gate runs them on its first publish); one that fails is a line for the person, not a 500.
  const cases: NonNullable<typeof design.cases> = [];
  const needs = [...design.needs];
  for (const draft of design.cases ?? []) {
    try {
      addCase(agent.id, draft);
      cases.push(draft);
    } catch {
      if (!needs.some((n) => n.tool === 'test cases')) needs.push({ tool: 'test cases', kind: 'parameter', text: 'Add test cases on the Evaluations tab' });
    }
  }
  return json({ agent, needs, missing: design.missing, dropped: design.dropped, designed: design.designed, cases /* SB17: */, notAdded: design.notAdded, models /* AG02: */ }, 201);
});

// SB18: take back an agent Spotlight made for a step when its change is undone, only when nothing else uses it.
const TakeBack = z.object({ agentId: z.string().min(1).max(200), workflowId: z.string().min(1).max(200) });

/** DELETE { agentId, workflowId } — answers `{ deleted: true }`, or `{ deleted: false, usedBy: string[] }` with what still uses it. */
export const DELETE = handler(async (request: Request) => {
  const parsed = await parseBody(request, TakeBack);
  if (!parsed.ok) return parsed.response;
  const { agentId, workflowId } = parsed.data;
  if (!agentStore.get(agentId) || !canResource(routeActor(), 'agent', agentId, 'delete')) return error('Agent not found', 404);
  const usedBy = agentUsedBy(agentId, workflowId);
  if (usedBy.length) return json({ deleted: false, usedBy });
  return json({ deleted: await removeAgent(agentId) });
});
