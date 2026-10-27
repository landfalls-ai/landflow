/**
 * What Microsoft Teams sends to Landflow: the Bot Framework messaging endpoint of an agent's Teams channel,
 * POST /api/teams/messages/<agentId>/<channelId> (set it as the bot registration's messaging endpoint).
 *
 * The bearer JWT is validated first (./index.ts verifyBotRequest); the activity is acknowledged at once and answered through
 * its `serviceUrl`. A `message` runs the published agent (the @mention is stripped; `/new` starts a new conversation); each
 * Teams conversation (a chat, or a thread in a channel) is one session. Tools that need approval are posted as an Adaptive
 * Card with Approve / Reject buttons (`Action.Execute`, Universal Actions): the click comes back as an `adaptiveCard/action`
 * invoke, answered in the HTTP response with the card that replaces the clicked one, and the decision (lib/server/agents/
 * runtime.ts `decide`) carries on the run in the background. Hosts without Universal Actions fall back to `Action.Submit`:
 * a message activity with the action's data as its `value`, after which the card is replaced through the Bot Connector.
 */
import type { JsonObject } from '@landflow/protocol';
import type { Agent, AgentChannel } from '../../shared/agents';
import { allowed } from '../agents/triggers';
import { decide, newSession, runAgent, type RunResult } from '../agents/runtime';
import { agentStore } from '../agents/store';
import { error } from '../http';
import { inBackground, parseTarget, type ApprovalTarget } from '../slack';
import { singleton } from '../singleton';
import { logger } from '../telemetry';
import {
  APPROVAL_MARK,
  approvalCard,
  conversationOf,
  decidedCard,
  plainText,
  sendActivity,
  sendText,
  teamsCredentialFor,
  updateActivity,
  verifyBotRequest,
  type Activity,
  type Conversation,
  type TeamsCredential,
} from './index';

const seen = singleton('teams-activities-seen', () => new Map<string, number>());
const SEEN_TTL_MS = 60 * 60_000;

function firstTime(id: string | undefined): boolean {
  if (!id) return true;
  const now = Date.now();
  for (const [key, at] of seen) if (now - at > SEEN_TTL_MS) seen.delete(key);
  if (seen.has(id)) return false;
  seen.set(id, now);
  return true;
}

function agentChannel(agentId: string, channelId: string): { agent: Agent; channel: AgentChannel; version: number } | undefined {
  const agent = agentStore.get(agentId);
  const published = agent?.published;
  const channel = published?.config.channels.find((c) => c.id === channelId && c.type === 'teams');
  if (!agent || !published || !channel) return undefined;
  return { agent, channel, version: published.version };
}

/** Who is talking, for the allow list: the Entra object id (else the Teams id; both are matched). */
const speaker = (activity: Activity) => ({ id: activity.from?.aadObjectId ?? activity.from?.id, ...(activity.from?.id && { username: activity.from.id }) });

/** POST /api/teams/messages/<agentId>/<channelId> */
export async function handleTeamsActivity(request: Request, agentId: string, channelId: string): Promise<Response> {
  const raw = await request.text();
  const found = agentChannel(agentId, channelId);
  if (!found) return error('No published agent has this Teams channel', 404);
  let credential: TeamsCredential;
  try {
    credential = await teamsCredentialFor(found.channel.credential);
  } catch (caught) {
    return error((caught as Error).message, 500);
  }
  let activity: Activity;
  try {
    activity = JSON.parse(raw) as Activity;
  } catch {
    return error('Expected a JSON activity', 400);
  }
  const verified = await verifyBotRequest(credential, request.headers.get('authorization'), activity.serviceUrl);
  if (!verified.ok) return error(verified.reason, 401);
  const to = conversationOf(activity);
  if (!to || !found.channel.enabled) return new Response(null, { status: 200 });
  if (activity.type === 'invoke' && activity.name === 'adaptiveCard/action') return executeClick(found, credential, activity, to);
  if (activity.type !== 'message') return new Response(null, { status: 200 });
  // Bot Framework retries an activity it got no answer for: acknowledge, don't answer twice.
  if (!firstTime(activity.id)) return new Response(null, { status: 200 });
  inBackground(
    () => (isApprovalClick(activity) ? decideClick(found, credential, activity, to) : answer(found.agent, found.version, found.channel, credential, activity, to)),
    (caught) => logger.warn('teams activity failed', { 'gen_ai.agent.id': agentId, error: (caught as Error).message }),
  );
  return new Response(null, { status: 200 });
}

const isApprovalData = (value: unknown) => Boolean(value && typeof value === 'object' && (value as { [k: string]: unknown })[APPROVAL_MARK]);
const isApprovalClick = (activity: Activity) => isApprovalData(activity.value);

/** The conversation key, and where to reach the conversation again (an approval decided by email replies there). */
const keyOf = (channel: AgentChannel, to: Conversation) => `teams:${channel.id}:${to.conversationId}`;
const refKey = (key: string) => `teams-ref:${key}`;

async function answer(agent: Agent, version: number, channel: AgentChannel, credential: TeamsCredential, activity: Activity, to: Conversation) {
  const reply = (message: string) => sendText(credential, to, message);
  if (!allowed(channel, speaker(activity))) {
    await reply('Sorry, this agent only talks to people its owner allowed.');
    logger.warn('teams message from a user not on the allow list', { 'gen_ai.agent.id': agent.id, 'landflow.teams.user': activity.from?.aadObjectId ?? activity.from?.id ?? 'unknown' });
    return;
  }
  const text = plainText(activity);
  if (!text) {
    await reply('Ask me something!');
    return;
  }
  const key = keyOf(channel, to);
  const userId = `teams:${activity.from?.aadObjectId ?? activity.from?.id ?? 'unknown'}`;
  if (['/new', 'new'].includes(text.toLowerCase())) {
    agentStore.saveSession(newSession(agent, { source: 'teams', userId, version, conversationKey: key, title: 'New conversation' }));
    await reply('Started a new conversation.');
    return;
  }
  let session = agentStore.findConversation(agent.id, key);
  const idleMinutes = channel.newSessionAfterMinutes;
  if (session && idleMinutes > 0 && Date.now() - Date.parse(session.updatedAt) > idleMinutes * 60_000) session = undefined;
  if (session && session.version !== version) session = { ...session, version };
  if (session?.status === 'awaiting_approval') {
    await reply('I’m waiting for an approval in this conversation first.');
    return;
  }
  session ??= newSession(agent, { source: 'teams', userId, version, conversationKey: key, title: text.slice(0, 80) });
  agentStore.setChannelState(refKey(key), { serviceUrl: to.serviceUrl, conversationId: to.conversationId, ...(to.bot && { bot: { id: to.bot.id ?? null, name: to.bot.name ?? null } }) });
  const result = await runAgent({ agent, session, message: text, approvals: 'ask', rootTrace: true });
  await deliver(agent, channel, credential, to, result);
}

/** Post the run's outcome: the reply, or one approval card per call that waits. */
async function deliver(agent: Agent, channel: AgentChannel, credential: TeamsCredential, to: Conversation, result: RunResult) {
  if (result.reason === 'awaiting_approval' && result.session.pending) {
    const name = agent.published?.config.name ?? agent.name;
    for (const call of result.session.pending.calls.filter((c) => !c.decision)) {
      const target: ApprovalTarget = { t: 'agent', a: agent.id, ch: channel.id, s: result.session.id, c: call.callId };
      await sendActivity(credential, to, { card: approvalCard({ title: `${name} wants to run a tool`, tool: call.tool, input: call.input, target }) });
    }
    return;
  }
  const reply =
    result.reply ??
    (result.reason === 'budget'
      ? 'I reached my usage limit, so I stopped. Try again later or ask the owner to raise it.'
      : result.reason === 'max_iterations'
        ? 'I couldn’t finish that within my step limit. Try a narrower request.'
        : 'Something went wrong while answering. Please try again.');
  await sendText(credential, to, reply);
}

type Found = { agent: Agent; channel: AgentChannel };
type Click = { target: Extract<ApprovalTarget, { t: 'agent' }>; approved: boolean; card: JsonObject; by: string };

/** What an Approve / Reject click decides, once it is ours, for this channel, by someone it allows and still waiting. */
function readClick(found: Found, activity: Activity, value: unknown): Click | { refusal: string } | undefined {
  const { approved, target: raw } = (value ?? {}) as { approved?: unknown; target?: unknown };
  const target = parseTarget(JSON.stringify(raw));
  if (!target || target.t !== 'agent' || typeof approved !== 'boolean') return undefined;
  if (target.a !== found.agent.id || target.ch !== found.channel.id) throw new Error('The approval does not belong to this Teams channel');
  if (!allowed(found.channel, speaker(activity))) return { refusal: `${activity.from?.name ?? 'You'}: only the people this agent talks to can approve its tools.` };
  const call = agentStore.getSession(target.s)?.pending?.calls.find((c) => c.callId === target.c);
  if (!call) return undefined;
  if (call.decision) return { refusal: `This tool call was already ${call.decision}.` };
  const name = found.agent.published?.config.name ?? found.agent.name;
  const card = decidedCard({ title: `${name} wants to run a tool`, tool: call.tool, input: call.input, approved, ...(activity.from?.name && { by: activity.from.name }) });
  return { target, approved, card, by: `teams:${activity.from?.aadObjectId ?? activity.from?.id ?? 'unknown'}` };
}

async function decideAndDeliver(found: Found, credential: TeamsCredential, to: Conversation, click: Click) {
  const outcome = await decide(found.agent, click.target.s, click.target.c, click.approved, { by: click.by });
  if (outcome.status === 'resumed') await deliver(found.agent, found.channel, credential, to, outcome);
}

/** An `Action.Submit` click (hosts without Universal Actions): a message activity replying to the card. */
async function decideClick(found: Found, credential: TeamsCredential, activity: Activity, to: Conversation) {
  const click = readClick(found, activity, activity.value);
  if (!click) return;
  if ('refusal' in click) {
    await sendText(credential, to, click.refusal);
    return;
  }
  // The card is the message the click replies to.
  if (activity.replyToId) {
    await updateActivity(credential, to, activity.replyToId, { card: click.card }).catch((caught: Error) => logger.warn('could not update the Teams approval card', { error: caught.message }));
  }
  await decideAndDeliver(found, credential, to, click);
}

/** The body of an invoke's answer (Bot Framework InvokeResponse): a card that replaces the clicked one, or a message. */
const invokeAnswer = (type: string, value: unknown, statusCode = 200) => Response.json({ statusCode, type, value });
const invokeMessage = (text: string) => invokeAnswer('application/vnd.microsoft.activity.message', text);

/** An `Action.Execute` click: answered at once with the decided card; the decision and the rest of the run go on in the background. */
function executeClick(found: Found, credential: TeamsCredential, activity: Activity, to: Conversation): Response {
  const action = (typeof activity.value === 'object' ? activity.value.action : undefined) as { type?: unknown; data?: unknown } | undefined;
  if (action?.type !== 'Action.Execute' || !isApprovalData(action.data)) return invokeMessage('Landflow has nothing to do for this card.');
  let click: ReturnType<typeof readClick>;
  try {
    click = readClick(found, activity, action.data);
  } catch (caught) {
    return invokeAnswer('application/vnd.microsoft.error', { code: 'BadRequest', message: (caught as Error).message }, 400);
  }
  if (!click) return invokeMessage('This approval is no longer waiting.');
  if ('refusal' in click) return invokeMessage(click.refusal);
  const decided = click;
  inBackground(
    () => decideAndDeliver(found, credential, to, decided),
    (caught) => logger.warn('teams approval failed', { 'gen_ai.agent.id': found.agent.id, error: (caught as Error).message }),
  );
  return invokeAnswer('application/vnd.microsoft.card.adaptive', click.card);
}

/** After an approval decided elsewhere (an emailed link) resumed a Teams session: the answer goes to its conversation. */
export async function deliverResumedTeams(agent: Agent, outcome: RunResult) {
  const key = outcome.session.conversationKey ?? '';
  const channel = agentChannel(agent.id, key.split(':')[1] ?? '')?.channel;
  const ref = agentStore.channelState(refKey(key)) as { serviceUrl?: string; conversationId?: string; bot?: { id?: string; name?: string } } | undefined;
  if (!channel || !ref?.serviceUrl || !ref.conversationId) return;
  const credential = await teamsCredentialFor(channel.credential);
  await deliver(agent, channel, credential, { serviceUrl: ref.serviceUrl, conversationId: ref.conversationId, ...(ref.bot && { bot: ref.bot }) }, outcome);
}
