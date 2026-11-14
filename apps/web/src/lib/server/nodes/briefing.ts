/**
 * The tomorrow sync's brain nodes (docs/work-and-briefings.md#the-nightly-sync): List People, Gather Work, Write Briefing,
 * Save Briefing and Deliver Briefing. They run in order in the `brain-tomorrow-sync` template. Items carry ids and counts only
 * (`{ userId, day, briefingId, counts }`): each person's gathered work and text live in their own row (brain/briefings-store.ts),
 * which only they read, because the run data of a workflow is visible to everyone who can open it.
 */
import { defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type NodeItem } from '@landflow/sdk';
import { getUser, listUsers, type UserRecord } from '../auth/users';
import { sendMail, mailConfigured } from '../auth/mail';
import { gatherFor, writeBriefingText } from '../brain/briefing';
import { createDraft, getBriefing, getDraft, markReady, pruneBriefings, writeText, type StoredBriefing } from '../brain/briefings-store';
import { brainModel } from '../brain/writer';
import { database } from '../db';
import { getPreferences } from '../preferences';
import { postMessage, SLACK_CREDENTIAL, SLACK_OAUTH2_CREDENTIAL, slackCredential, type SlackCredential } from '../slack';
import { logger } from '../telemetry/logger';
import { brainEnabled, dayOf } from '../usage/ledger';

const main = [{ type: 'main' as const }];
const icon = { icon: 'lucide:sunrise', color: '#8b5cf6', categories: ['AI', 'Core'] };

/** The day after `day` (YYYY-MM-DD), by the calendar. */
const dayAfter = (day: string): string => {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
};

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** The item's person: an active user, or a node error naming the item. */
function personOf(item: NodeItem, index: number): { user: UserRecord; day: string } {
  const userId = text(item.json.userId);
  const user = userId ? getUser(userId) : undefined;
  if (!user || user.disabledAt) throw new NodeOperationError('The item has no active person (userId)', { itemIndex: index, description: 'Run List People first.' });
  const day = text(item.json.day);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new NodeOperationError('The item has no day (YYYY-MM-DD)', { itemIndex: index });
  return { user, day };
}

const countsOf = (briefing: StoredBriefing) => ({ own: briefing.gathered.own.length, related: briefing.gathered.related.length, finished: briefing.gathered.finished.length });
const outOf = (briefing: StoredBriefing, index: number, extra: JsonObject = {}): NodeItem => ({ json: { userId: briefing.userId, day: briefing.day, briefingId: briefing.id, counts: countsOf(briefing), ...extra }, pairedItem: { item: index } });

function draftOf(item: NodeItem, index: number): StoredBriefing {
  const { user } = personOf(item, index);
  const draft = getDraft(text(item.json.briefingId), user.id);
  if (!draft) throw new NodeOperationError('The briefing draft is gone', { itemIndex: index, description: 'Gather Work makes the draft; run it before this node.' });
  return draft;
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
      { name: 'day', displayName: 'Day', type: 'string', default: '', placeholder: 'next day', description: 'The day the briefings are for, YYYY-MM-DD. Empty: the next day in the instance time zone.' },
    ],
  },
  async execute(ctx) {
    if (!brainEnabled()) return [[]];
    const withinDays = Math.max(0, Math.floor(Number(ctx.getNodeParameter('withinDays', 0, 3)) || 0));
    const given = text(ctx.getNodeParameter('day', 0, ''));
    if (given && !/^\d{4}-\d{2}-\d{2}$/.test(given)) throw new NodeOperationError('Day must be YYYY-MM-DD');
    const day = given || dayAfter(dayOf(Date.now()));
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
    const out: NodeItem[] = [];
    const items = ctx.getInputData();
    for (const [index, item] of items.entries()) {
      const { user, day } = personOf(item, index);
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
      const written = await writeBriefingText(draft.gathered, model);
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
    const out: NodeItem[] = [];
    for (const [index, item] of ctx.getInputData().entries()) {
      const draft = draftOf(item, index);
      if (!draft.text) throw new NodeOperationError('The draft has no text yet', { itemIndex: index, description: 'Write Briefing writes it.' });
      const ready = markReady(draft.id, draft.userId);
      if (!ready) throw new NodeOperationError('The briefing draft is gone', { itemIndex: index });
      out.push(outOf(ready, index));
    }
    pruneBriefings();
    return [out];
  },
});

const slackCredentialOf = (ctx: IExecuteContext): SlackCredential | undefined => {
  for (const type of [SLACK_CREDENTIAL, SLACK_OAUTH2_CREDENTIAL]) {
    try {
      const data = ctx.getCredentials<JsonObject>(type);
      if (data) return slackCredential(data);
    } catch {
      // Not set: the other type, or no Slack delivery.
    }
  }
  return undefined;
};

/** The Slack member behind an email, if Slack knows it (a GET: users.lookupByEmail takes no JSON). */
async function slackMemberOf(credential: SlackCredential, email: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${credential.baseUrl}/users.lookupByEmail?${new URLSearchParams({ email })}`, { headers: { authorization: `Bearer ${credential.accessToken}` }, signal: AbortSignal.timeout(15_000) });
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
    description: 'Send a person’s briefing by Slack or email, only when they chose that in their preferences. Everyone else gets it where they start their day.',
    version: 1,
    kind: 'action',
    ...icon,
    subtitle: 'only if they opted in',
    keywords: ['briefing', 'deliver', 'slack', 'email', 'tomorrow sync', 'second brain'],
    inputs: main,
    outputs: main,
    credentials: [
      { name: SLACK_CREDENTIAL, required: false },
      { name: SLACK_OAUTH2_CREDENTIAL, required: false },
    ],
    properties: [],
  },
  async execute(ctx) {
    const out: NodeItem[] = [];
    const slack = slackCredentialOf(ctx);
    for (const [index, item] of ctx.getInputData().entries()) {
      const { user } = personOf(item, index);
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
      out.push({ json: { ...(item.json as JsonObject), delivered: Boolean(channel), ...(channel && { channel }) }, pairedItem: { item: index } });
    }
    return [out];
  },
});

export const briefingNodes = [brainListPeopleNode, brainGatherWorkNode, brainWriteBriefingNode, brainSaveBriefingNode, brainDeliverBriefingNode];
