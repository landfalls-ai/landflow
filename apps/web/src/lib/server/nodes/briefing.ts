/**
 * The tomorrow sync's brain nodes (docs/work-and-briefings.md#the-nightly-sync): List People, Gather Work, Write Briefing,
 * Save Briefing and Deliver Briefing. They run in order in the `brain-tomorrow-sync` template. Items carry ids and counts only
 * (`{ userId, day, briefingId, counts }`): each person's gathered work and text live in their own row (brain/briefings-store.ts),
 * which only they read, because the run data of a workflow is visible to everyone who can open it.
 */
import { pinsApply, type Workflow } from '@landflow/engine';
import { defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type NodeItem } from '@landflow/sdk';
import { getUser, isActiveAdmin, listUsers, type UserRecord } from '../auth/users';
import { sendMail, mailConfigured } from '../auth/mail';
import { gatherFor, writeBriefingText } from '../brain/briefing';
import { createDraft, getBriefing, getDraft, markReady, pruneBriefings, writeText, type StoredBriefing } from '../brain/briefings-store';
import { brainModel } from '../brain/writer';
import { database } from '../db';
import { getPreferences } from '../preferences';
import { postMessage, SLACK_API, type SlackCredential } from '../slack';
import { envString, envUrl } from '../config';
import { safeFetch } from '../net/safe-fetch';
import { logger } from '../telemetry/logger';
import { brainEnabled, dayOf } from '../usage/ledger';
import { store } from '../store';
import { getPublication } from '../publications';
import { getVersion, versionAuthor, versionFor } from '../versions';
import type { ExecutionRecord } from '../../shared/types';

const main = [{ type: 'main' as const }];
const icon = { icon: 'lucide:sunrise', color: '#8b5cf6', categories: ['AI', 'Core'] };

/** An active owner or admin. */
const trusted = isActiveAdmin;

/** Modes nobody starts by hand: a schedule or other trigger, a poll, a webhook. */
const SYSTEM_MODES: ReadonlySet<string> = new Set(['trigger', 'poll', 'webhook']);

/** Why `workflow` may not handle people's briefings at all, or undefined: a member made it (`createdBy` comes only from the saver). */
function workflowRefusal(workflow: Workflow | undefined): string | undefined {
  if (!workflow) return 'The workflow is not saved';
  if (workflow.createdBy && !trusted(workflow.createdBy)) return 'Only a workflow an owner or admin made may handle people’s briefings';
  return undefined;
}

const RUN_REFUSED = 'Only a schedule of the published workflow, or a run an owner or admin started, may handle people’s briefings';
const VERSION_REFUSED = 'A member, or nobody, saved the version of this workflow that ran: it handles no one’s briefings until an owner or admin saves a change to it (and publishes that version, when it is published)';
const UNPUBLISHED_REFUSED = 'A schedule handles people’s briefings only from the published version: an owner or admin publishes it first';
const PUBLISH_REFUSED = 'A member published the version of this workflow that ran: it handles no one’s briefings until an owner or admin publishes a version an owner or admin saved';

/**
 * Why the version a run without a starter ran may not handle people's briefings, or undefined. It must be the workflow's
 * published version (a draft has only one key, its author; publishing adds the second), saved by an owner or admin
 * (versionAuthor: the person whose save made that version, never whoever saved last, moved or restored it), and, when
 * published by an owner or admin too. Pin data is not part of a version, and production
 * runs ignore it (the engine's PINLESS_MODES).
 */
function versionRefusal(record: ExecutionRecord): string | undefined {
  const workflow = store.getWorkflow(record.workflowId);
  const refused = workflowRefusal(workflow);
  if (refused) return refused;
  if (!record.versionId) return RUN_REFUSED;
  const publication = getPublication(workflow!.id);
  const isPublished = publication?.versionId === record.versionId;
  if (!isPublished) return UNPUBLISHED_REFUSED;
  if (!trusted(versionAuthor(workflow!.id, record.versionId))) return VERSION_REFUSED;
  if (!trusted(publication!.publishedBy)) return PUBLISH_REFUSED;
  return undefined;
}

/** A run's record: the live one while it runs (the saved row lags behind), else the saved one. */
async function runRecord(executionId: string | undefined): Promise<ExecutionRecord | undefined> {
  if (!executionId) return undefined;
  const { live } = await import('../runner/state');
  return live.get(executionId)?.record ?? (await store.loadExecution(executionId));
}

/**
 * Why this run may not handle people's briefings, or undefined when it may. A run a person started (`startedBy`: the
 * editor, the API, chat, MCP, an agent's tool for its caller, a re-run, a retry they asked for, or a sub-workflow of one)
 * may when that person is an owner or admin. A run nobody started may only when its version passes versionRefusal, it is
 * not a re-run, a retry someone asked for or a metric's measurement, and what it came from may too: the run an automatic
 * retry retries, the failed run an error workflow answers, the run a sub-workflow (or an agent's tool call) was started
 * by. A run with none of those must be a trigger's (`trigger`, `poll`, `webhook`).
 */
async function runRefusal(record: ExecutionRecord | undefined, depth = 0): Promise<string | undefined> {
  if (!record || record.evaluation || depth > 8) return RUN_REFUSED;
  if (record.startedBy) return trusted(record.startedBy) ? undefined : RUN_REFUSED;
  if (record.rerunOf || (record.retryOf && !record.retryAutomatic) || record.metricOf) return RUN_REFUSED;
  const refused = versionRefusal(record);
  if (refused) return refused;
  for (const from of [record.retryOf, record.errorOf]) {
    if (!from) continue;
    const source = await runRefusal(await runRecord(from), depth + 1);
    if (source) return source;
  }
  if (record.parentExecutionId) return runRefusal(await runRecord(record.parentExecutionId), depth + 1);
  return SYSTEM_MODES.has(record.mode) ? undefined : RUN_REFUSED;
}

/** The graph a run ran: its own copy (an unsaved draft), else the saved version it started on. */
function ranWorkflow(record: ExecutionRecord | undefined): Workflow | undefined {
  if (!record) return undefined;
  return record.workflow ?? (record.versionId ? getVersion(record.workflowId, record.versionId)?.workflow : undefined);
}

/** `nodeId` and every node that feeds it in `workflow`. */
function upstreamOf(workflow: Workflow, nodeId: string): Set<string> {
  const seen = new Set([nodeId]);
  const queue = [nodeId];
  while (queue.length) {
    const id = queue.pop()!;
    for (const connection of workflow.connections ?? []) {
      if (connection.target !== id || seen.has(connection.source)) continue;
      seen.add(connection.source);
      queue.push(connection.source);
    }
  }
  return seen;
}

const PIN_REFUSED = 'Pin data on this node or a node before it would choose whose briefing this run handles: remove the pins (they are test data) and run it again';

/**
 * Why pin data could decide what this node handles, or undefined. Runs a person starts use pins (the engine's
 * `pinsApply`), and pins are no part of a version: a member's pin-only save on List People would make an owner's manual
 * run write a briefing for the person and day the member chose. So such a run refuses when this node or one upstream
 * has pins, in the graph that ran or in the saved workflow.
 */
function pinRefusal(ctx: IExecuteContext, record: ExecutionRecord | undefined): string | undefined {
  if (!pinsApply(ctx.getMode())) return undefined;
  const nodeId = ctx.getNode().id;
  for (const workflow of [ranWorkflow(record), store.getWorkflow(ctx.getWorkflowId() ?? '')]) {
    const pins = workflow?.pinData;
    if (!pins) continue;
    for (const id of upstreamOf(workflow, nodeId)) if (pins[id]?.length) return PIN_REFUSED;
  }
  return undefined;
}

/**
 * Who may run the nodes that read or write a person's private briefing (docs/work-and-briefings.md#the-nightly-sync, Privacy): a workflow
 * no member made, in a run an owner or admin started, or a schedule's run of a version an owner or admin saved (and, if
 * it is the published one, published) (`runRefusal`), with no pin data deciding the items (`pinRefusal`). A member could
 * otherwise feed any `userId` through them (an MCP call from Gather Work, a re-run of the nightly run with an older graph,
 * a version of their own published, a pin) and read or send someone else's work. Returns the run's record.
 */
async function requireInstanceFlow(ctx: IExecuteContext): Promise<ExecutionRecord | undefined> {
  const record = await runRecord(ctx.getExecutionId());
  const refused = workflowRefusal(store.getWorkflow(ctx.getWorkflowId() ?? '')) ?? (await runRefusal(record)) ?? pinRefusal(ctx, record);
  if (refused) throw new NodeOperationError(refused, { description: 'A person’s briefing is private to them: an owner or admin saves and publishes this workflow, and it runs on its schedule or as theirs.' });
  return record;
}

/** PR03: `requireInstanceFlow`'s test without the throw: the refusal it would give, or undefined when this flow is an owner's or admin's. */
export async function instanceFlowRefusal(ctx: IExecuteContext): Promise<string | undefined> {
  const record = await runRecord(ctx.getExecutionId());
  return workflowRefusal(store.getWorkflow(ctx.getWorkflowId() ?? '')) ?? (await runRefusal(record)) ?? pinRefusal(ctx, record);
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const skip = (reason: string, index: number) => logger.warn(`briefing: skipping item ${index}: ${reason}`);

/** The item's person: an active user and a day, or undefined (a user disabled since List People; the item is skipped, not the run). */
function personOf(item: NodeItem, index: number): { user: UserRecord; day: string } | undefined {
  const userId = text(item.json.userId);
  const user = userId ? getUser(userId) : undefined;
  if (!user || user.disabledAt) return skip('no active person (userId)', index), undefined;
  const day = text(item.json.day);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return skip('no day (YYYY-MM-DD)', index), undefined;
  return { user, day };
}

const countsOf = (briefing: StoredBriefing) => ({ own: briefing.gathered.own.length, related: briefing.gathered.related.length, finished: briefing.gathered.finished.length });
const outOf = (briefing: StoredBriefing, index: number, extra: JsonObject = {}): NodeItem => ({ json: { userId: briefing.userId, day: briefing.day, briefingId: briefing.id, counts: countsOf(briefing), ...extra }, pairedItem: { item: index } });

/** The item's draft, or undefined (skipped with a warning) when its person or draft is gone, e.g. replaced by a concurrent run. */
function draftOf(item: NodeItem, index: number): StoredBriefing | undefined {
  const person = personOf(item, index);
  const draft = person && getDraft(text(item.json.briefingId), person.user.id);
  if (person && !draft) skip('the briefing draft is gone', index);
  return draft || undefined;
}

export const brainListPeopleNode = defineNode({
  description: {
    name: 'brainListPeople',
    displayName: 'List People',
    description: 'One item for each active person with work in the second brain lately, to prepare tomorrow’s briefing for',
    version: 1,
    kind: 'action',
    ...icon,
    subtitle: 'work in the last {{withinDays}} days',
    keywords: ['briefing', 'people', 'users', 'tomorrow sync', 'second brain'],
    inputs: main,
    outputs: main,
    properties: [
      { name: 'withinDays', displayName: 'Work in the Last (Days)', type: 'number', default: 3, typeOptions: { minValue: 0, maxValue: 90 }, description: 'Only people who recorded work in this many days. 0: every active person.' },
      { name: 'day', displayName: 'Day', type: 'string', default: '', placeholder: 'today', description: 'The day the briefings are read on, YYYY-MM-DD. Empty: today in the instance time zone, so a run at 02:00 prepares the briefing for the morning that follows and gathers yesterday and today so far.' },
    ],
  },
  async execute(ctx) {
    if (!brainEnabled()) return [[]];
    // Who recorded work lately is other people's data too.
    await requireInstanceFlow(ctx);
    const withinDays = Math.max(0, Math.floor(Number(ctx.getNodeParameter('withinDays', 0, 3)) || 0));
    const given = text(ctx.getNodeParameter('day', 0, ''));
    if (given && !/^\d{4}-\d{2}-\d{2}$/.test(given)) throw new NodeOperationError('Day must be YYYY-MM-DD');
    const day = given || dayOf(Date.now());
    const active = withinDays
      ? new Set(database().all<{ owner_id: string }>(`SELECT DISTINCT owner_id FROM usage_events WHERE kind LIKE 'work.%' AND source_id IS NOT NULL AND owner_id IS NOT NULL AND at >= ?`, new Date(Date.now() - withinDays * 86_400_000).toISOString()).map((row) => row.owner_id))
      : undefined;
    const out: NodeItem[] = listUsers()
      .filter((user) => !user.disabledAt && (!active || active.has(user.id)))
      .map((user) => ({ json: { userId: user.id, day } }));
    return [out];
  },
});

export const brainGatherWorkNode = defineNode({
  description: {
    name: 'brainGatherWork',
    displayName: 'Gather Work',
    description: 'For each person, gather their own work, colleagues’ shared work that overlaps it, and what finished that they wait on. Kept in their own draft, not in the items.',
    version: 1,
    kind: 'action',
    ...icon,
    subtitle: 'own, related, finished',
    keywords: ['briefing', 'gather', 'work', 'tomorrow sync', 'second brain'],
    inputs: main,
    outputs: main,
    properties: [],
  },
  async execute(ctx) {
    if (!brainEnabled()) return [[]];
    await requireInstanceFlow(ctx);
    const out: NodeItem[] = [];
    const items = ctx.getInputData();
    for (const [index, item] of items.entries()) {
      const person = personOf(item, index);
      if (!person) continue;
      const { user, day } = person;
      const gathered = gatherFor({ id: user.id, role: user.role }, day);
      const draft = createDraft({ userId: user.id, day, gathered, workflowId: ctx.getWorkflowId(), executionId: ctx.getExecutionId() });
      out.push(outOf(draft, index));
    }
    return [out];
  },
});

export const brainWriteBriefingNode = defineNode({
  description: {
    name: 'brainWriteBriefing',
    displayName: 'Write Briefing',
    description: 'Write each person’s briefing from their draft: the brain’s model when one is set, else a plain summary of the lists',
    version: 1,
    kind: 'action',
    ...icon,
    subtitle: 'the brain’s model or plain text',
    keywords: ['briefing', 'write', 'summary', 'tomorrow sync', 'second brain'],
    inputs: main,
    outputs: main,
    properties: [{ name: 'useModel', displayName: 'Use the Brain’s Model', type: 'boolean', default: true, description: 'Off, or with the model off or failing, the text is built from the lists alone. Redacted lines only ever reach the model, as data.' }],
  },
  async execute(ctx) {
    if (!brainEnabled()) return [[]];
    await requireInstanceFlow(ctx);
    const out: NodeItem[] = [];
    const items = ctx.getInputData();
    let model: ReturnType<typeof brainModel>;
    try {
      model = ctx.getNodeParameter('useModel', 0, true) ? brainModel() : undefined;
    } catch (error) {
      logger.warn('briefing: the brain model is unavailable, writing plain text', { error: String(error) });
    }
    for (const [index, item] of items.entries()) {
      const draft = draftOf(item, index);
      if (!draft) continue;
      const written = await writeBriefingText(draft.gathered, model, AbortSignal.timeout(60_000));
      out.push(outOf(writeText(draft.id, draft.userId, written.text, written.model) ?? draft, index));
    }
    return [out];
  },
});

export const brainSaveBriefingNode = defineNode({
  description: {
    name: 'brainSaveBriefing',
    displayName: 'Save Briefing',
    description: 'Make each person’s draft their briefing for the day, replacing an older one. Only they can read it.',
    version: 1,
    kind: 'action',
    ...icon,
    subtitle: 'ready for the day',
    keywords: ['briefing', 'save', 'tomorrow sync', 'second brain'],
    inputs: main,
    outputs: main,
    properties: [],
  },
  async execute(ctx) {
    if (!brainEnabled()) return [[]];
    await requireInstanceFlow(ctx);
    const out: NodeItem[] = [];
    for (const [index, item] of ctx.getInputData().entries()) {
      const draft = draftOf(item, index);
      if (!draft) continue;
      if (!draft.text) throw new NodeOperationError('The draft has no text yet', { itemIndex: index, description: 'Write Briefing writes it.' });
      const ready = markReady(draft.id, draft.userId);
      if (!ready) throw new NodeOperationError('The briefing draft is gone', { itemIndex: index });
      out.push(outOf(ready, index));
    }
    pruneBriefings();
    return [out];
  },
});

const SLACK_NOT_CONFIGURED =
  'Slack delivery skipped: Slack is not set up on this server. An admin sets LANDFLOW_BRIEFING_SLACK_TOKEN (a Slack bot token) on the server to deliver by Slack; email delivery goes on.';

/**
 * The Slack Deliver Briefing sends with: server configuration only, a bot token in LANDFLOW_BRIEFING_SLACK_TOKEN and Slack's
 * API (or LANDFLOW_BRIEFING_SLACK_URL, a proxy or a local fake), like email's LANDFLOW_SMTP_* settings. Never a credential
 * from the vault: anyone who can edit a project's credential could point its token or base URL at a workspace or server
 * of their own, and the nightly run would send everyone's email address and briefing there. Undefined: no token set.
 */
function briefingSlack(): SlackCredential | undefined {
  const accessToken = envString('LANDFLOW_BRIEFING_SLACK_TOKEN');
  return accessToken ? { accessToken, baseUrl: (envUrl('LANDFLOW_BRIEFING_SLACK_URL') ?? SLACK_API).replace(/\/+$/, '') } : undefined;
}

/** The Slack member behind an email, if Slack knows it (a GET: users.lookupByEmail takes no JSON). */
async function slackMemberOf(credential: SlackCredential, email: string): Promise<string | undefined> {
  try {
    const response = await safeFetch(`${credential.baseUrl}/users.lookupByEmail?${new URLSearchParams({ email })}`, { headers: { authorization: `Bearer ${credential.accessToken}` }, signal: AbortSignal.timeout(15_000) });
    const data = (await response.json().catch(() => undefined)) as { ok?: boolean; user?: { id?: string } } | undefined;
    return data?.ok === true ? data.user?.id : undefined;
  } catch {
    return undefined;
  }
}

export const brainDeliverBriefingNode = defineNode({
  description: {
    name: 'brainDeliverBriefing',
    displayName: 'Deliver Briefing',
    description: 'Send a person’s briefing by Slack or email, only when they chose that in their preferences, with the server’s own Slack bot and mail settings. Everyone else gets it where they start their day.',
    version: 1,
    kind: 'action',
    ...icon,
    subtitle: 'only if they opted in',
    keywords: ['briefing', 'deliver', 'slack', 'email', 'tomorrow sync', 'second brain'],
    inputs: main,
    outputs: main,
    properties: [],
  },
  async execute(ctx) {
    if (!brainEnabled()) return [[]];
    await requireInstanceFlow(ctx);
    const out: NodeItem[] = [];
    const slack = briefingSlack();
    let warned = false;
    for (const [index, item] of ctx.getInputData().entries()) {
      const person = personOf(item, index);
      if (!person) continue;
      const { user } = person;
      const briefing = getBriefing(text(item.json.briefingId), user.id);
      const choice = getPreferences(user.id).briefingDelivery;
      let channel: string | undefined;
      if (briefing?.status === 'ready' && briefing.text) {
        const subject = `Your briefing for ${briefing.day}`;
        try {
          if (choice === 'slack' && slack) {
            const member = await slackMemberOf(slack, user.email);
            if (member) {
              await postMessage(slack, { channel: member, text: `*${subject}*\n${briefing.text}` });
              channel = 'slack';
            }
          } else if (choice === 'email' && mailConfigured()) {
            await sendMail({ to: user.email, subject, text: briefing.text });
            channel = 'email';
          }
        } catch (error) {
          logger.warn('briefing delivery failed', { 'landflow.user.id': user.id, error: String(error) });
        }
      }
      const warning = choice === 'slack' && !slack ? SLACK_NOT_CONFIGURED : undefined;
      if (warning && !warned) {
        warned = true;
        ctx.logger.warn(warning);
        logger.warn('briefing: Slack delivery skipped', { 'landflow.briefing.skip_reason': 'not_configured', 'landflow.workflow.id': ctx.getWorkflowId(), 'landflow.execution.id': ctx.getExecutionId() });
      }
      out.push({ json: { ...(item.json as JsonObject), delivered: Boolean(channel), ...(channel && { channel }), ...(warning && { warning }) }, pairedItem: { item: index } });
    }
    return [out];
  },
});

export const briefingNodes = [brainListPeopleNode, brainGatherWorkNode, brainWriteBriefingNode, brainSaveBriefingNode, brainDeliverBriefingNode];
