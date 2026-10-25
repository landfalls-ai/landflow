/**
 * What Slack sends to Landflow:
 *
 * - Events API, per agent channel: POST /api/slack/events/<agentId>/<channelId>. The app's Request URL. Verified
 *   with the channel credential's signing secret; `url_verification` answers the challenge; `app_mention` and
 *   direct messages (`message` with `channel_type: im`) run the published agent and the reply goes back in the
 *   message's thread (each thread is a session). Retries (`X-Slack-Retry-Num`) and repeated event ids are
 *   ignored, and the event is acknowledged at once: Slack wants a 200 within 3 seconds.
 * - Interactivity: POST /api/slack/interactions. The approval buttons of AI Agent nodes (workflow executions)
 *   and of agents answering in Slack. Checked against every Slack credential's signing secret; the
 *   credential that verifies must be the one that posted the buttons.
 *
 * Tools that need approval pause the agent and post Approve / Reject buttons in the thread; the click decides
 * (lib/server/agents/runtime.ts `decide`) and the run continues.
 */
import type { Agent, AgentChannel } from '../../shared/agents';
import { allowed } from '../agents/triggers';
import { decide, newSession, runAgent, type RunResult } from '../agents/runtime';
import { agentStore } from '../agents/store';
import { ApprovalError, decideApproval, pendingApproval } from '../approvals';
import { error, json } from '../http';
import { singleton } from '../singleton';
import { store } from '../store';
import { logger } from '../telemetry';
import {
  APPROVE_ACTION,
  approvalBlocks,
  decidedBlocks,
  inBackground,
  parseTarget,
  postMessage,
  REJECT_ACTION,
  SLACK_CREDENTIAL,
  slackCredentialFor,
  slackCredentialsWithSecret,
  updateMessage,
  verifySlackRequest,
  type ApprovalTarget,
  type SlackCredential,
} from './index';

/** Event ids seen lately (Slack retries an event it thinks we missed). */
const seen = singleton('slack-events-seen', () => new Map<string, number>());
const SEEN_TTL_MS = 60 * 60_000;

function firstTime(eventId: string | undefined): boolean {
  if (!eventId) return true;
  const now = Date.now();
  for (const [id, at] of seen) if (now - at > SEEN_TTL_MS) seen.delete(id);
  if (seen.has(eventId)) return false;
  seen.set(eventId, now);
  return true;
}

interface SlackEvent {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
}

/** The published agent and its enabled Slack channel; undefined when either is missing. */
function agentChannel(agentId: string, channelId: string): { agent: Agent; channel: AgentChannel; version: number } | undefined {
  const agent = agentStore.get(agentId);
  const published = agent?.published;
  const channel = published?.config.channels.find((c) => c.id === channelId && c.type === 'slack');
  if (!agent || !published || !channel) return undefined;
  return { agent, channel, version: published.version };
}

/** POST /api/slack/events/<agentId>/<channelId> */
export async function handleSlackEvent(request: Request, agentId: string, channelId: string): Promise<Response> {
  const raw = await request.text();
  const found = agentChannel(agentId, channelId);
  if (!found) return error('No published agent has this Slack channel', 404);
  let credential: SlackCredential;
  try {
    credential = slackCredentialFor(found.channel.credential);
  } catch (caught) {
    return error((caught as Error).message, 500);
  }
  if (!credential.signingSecret) return error('Set the Signing Secret on the Slack credential: Landflow refuses unverified Slack requests', 401);
  const verified = verifySlackRequest(credential.signingSecret, request.headers, raw);
  if (!verified.ok) return error(verified.reason, 401);

  let body: { type?: string; challenge?: string; event_id?: string; event?: SlackEvent };
  try {
    body = JSON.parse(raw);
  } catch {
    return error('Expected a JSON body', 400);
  }
  if (body.type === 'url_verification') return json({ challenge: body.challenge ?? '' });
  if (body.type !== 'event_callback' || !body.event) return new Response(null, { status: 200 });
  if (!found.channel.enabled) return new Response(null, { status: 200 });
  // A retry of an event we already took (Slack retries when it got no 200 in time): acknowledge, don't answer twice.
  if (!firstTime(body.event_id)) return new Response(null, { status: 200, headers: { 'x-slack-no-retry': '1' } });

  const event = body.event;
  const isMention = event.type === 'app_mention';
  const isDirect = event.type === 'message' && event.channel_type === 'im' && !event.subtype;
  // The bot's own messages (and edits, joins…) are not questions.
  if ((!isMention && !isDirect) || event.bot_id || !event.user || !event.channel) return new Response(null, { status: 200 });
  inBackground(
    () => answer(found.agent, found.version, found.channel, credential, event),
    (caught) => logger.warn('slack event failed', { 'gen_ai.agent.id': agentId, error: (caught as Error).message }),
  );
  return new Response(null, { status: 200 });
}

async function answer(agent: Agent, version: number, channel: AgentChannel, credential: SlackCredential, event: SlackEvent) {
  const chat = event.channel!;
  const threadTs = channel.threadReplies === false ? undefined : (event.thread_ts ?? event.ts);
  if (!allowed(channel, { id: event.user })) {
    await postMessage(credential, { channel: chat, threadTs, text: 'Sorry, this agent only talks to people its owner allowed.' });
    logger.warn('slack message from a user not on the allow list', { 'gen_ai.agent.id': agent.id, 'landflow.slack.user': event.user ?? 'unknown' });
    return;
  }
  const text = (event.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!text) {
    await postMessage(credential, { channel: chat, threadTs, text: 'Ask me something!' });
    return;
  }
  const key = `slack:${channel.id}:${chat}${threadTs ? `:${threadTs}` : ''}`;
  let session = agentStore.findConversation(agent.id, key);
  const idleMinutes = channel.newSessionAfterMinutes;
  if (session && idleMinutes > 0 && Date.now() - Date.parse(session.updatedAt) > idleMinutes * 60_000) session = undefined;
  if (session && session.version !== version) session = { ...session, version };
  if (session?.status === 'awaiting_approval') {
    await postMessage(credential, { channel: chat, threadTs, text: 'I’m waiting for an approval in this thread first.' });
    return;
  }
  session ??= newSession(agent, { source: 'slack', userId: `slack:${event.user}`, version, conversationKey: key, title: text.slice(0, 80) });
  const result = await runAgent({ agent, session, message: text, approvals: 'ask', rootTrace: true });
  await deliver(agent, channel, credential, chat, threadTs, result);
}

/** Post the run's outcome: the reply, or one Approve / Reject message per call that waits. */
async function deliver(agent: Agent, channel: AgentChannel, credential: SlackCredential, chat: string, threadTs: string | undefined, result: RunResult) {
  if (result.reason === 'awaiting_approval' && result.session.pending) {
    const name = agent.published?.config.name ?? agent.name;
    for (const call of result.session.pending.calls.filter((c) => !c.decision)) {
      const target: ApprovalTarget = { t: 'agent', a: agent.id, ch: channel.id, s: result.session.id, c: call.callId, ...(threadTs && { th: threadTs }) };
      await postMessage(credential, { channel: chat, threadTs, text: `${name}: approve ${call.tool}?`, blocks: approvalBlocks({ title: `${name} wants to run a tool`, tool: call.tool, input: call.input, target }) });
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
  await postMessage(credential, { channel: chat, threadTs, text: reply });
}

interface InteractionPayload {
  type?: string;
  user?: { id?: string; username?: string };
  channel?: { id?: string };
  container?: { channel_id?: string; message_ts?: string; thread_ts?: string };
  message?: { ts?: string; thread_ts?: string };
  actions?: Array<{ action_id?: string; value?: string }>;
}

/** POST /api/slack/interactions */
export async function handleSlackInteraction(request: Request): Promise<Response> {
  const raw = await request.text();
  const candidates = slackCredentialsWithSecret();
  if (!candidates.length) return error('No Slack credential has a Signing Secret: Landflow refuses unverified Slack requests', 401);
  const verifiedBy = new Set(candidates.filter((c) => verifySlackRequest(c.credential.signingSecret!, request.headers, raw).ok).map((c) => c.id));
  if (!verifiedBy.size) return error('Invalid Slack signature', 401);

  let payload: InteractionPayload;
  try {
    payload = JSON.parse(new URLSearchParams(raw).get('payload') ?? '');
  } catch {
    return error('Expected a form body with a payload', 400);
  }
  if (payload.type !== 'block_actions') return new Response(null, { status: 200 });
  const action = payload.actions?.find((a) => a.action_id === APPROVE_ACTION || a.action_id === REJECT_ACTION);
  const target = parseTarget(action?.value);
  if (!action || !target) return new Response(null, { status: 200 });
  const approved = action.action_id === APPROVE_ACTION;
  const user = payload.user?.id;
  const chat = payload.container?.channel_id ?? payload.channel?.id;
  const ts = payload.container?.message_ts ?? payload.message?.ts;
  inBackground(
    () => (target.t === 'wf' ? decideWorkflow(target, approved, user, verifiedBy) : decideAgent(target, approved, user, verifiedBy, chat, ts)),
    (caught) => logger.warn('slack approval failed', { error: (caught as Error).message }),
  );
  return new Response(null, { status: 200 });
}

async function decideWorkflow(target: Extract<ApprovalTarget, { t: 'wf' }>, approved: boolean, user: string | undefined, verifiedBy: Set<string>) {
  // The credential that verified the click must be the node's (one Slack app can't decide another's approvals).
  const record = store.getExecution(target.e);
  const approval = pendingApproval(record) ?? (record?.wait?.data?.approval as { nodeName?: string; nodeId?: string } | undefined);
  const node = record?.workflow?.nodes.find((n) => n.id === approval?.nodeId || n.name === approval?.nodeName);
  const ref = node?.credentials?.[SLACK_CREDENTIAL];
  if (record && ref && !verifiedBy.has(ref.id)) throw new Error('The approval was signed by another Slack app than the one that asked');
  try {
    const outcome = await decideApproval(target.e, target.c, approved, { ...(user && { slackUser: user }) });
    logger.info('slack approval decided', { 'landflow.execution.id': target.e, 'landflow.approval.approved': approved, 'landflow.approval.status': outcome.status });
  } catch (caught) {
    if (!(caught instanceof ApprovalError)) throw caught;
    logger.warn('slack approval refused', { 'landflow.execution.id': target.e, error: caught.message });
  }
}

async function decideAgent(
  target: Extract<ApprovalTarget, { t: 'agent' }>,
  approved: boolean,
  user: string | undefined,
  verifiedBy: Set<string>,
  chat: string | undefined,
  ts: string | undefined,
) {
  const found = agentChannel(target.a, target.ch);
  if (!found || !verifiedBy.has(found.channel.credential.id)) throw new Error('The approval does not belong to a Slack channel of a published agent');
  const credential = slackCredentialFor(found.channel.credential);
  if (!allowed(found.channel, user ? { id: user } : null)) {
    if (chat) await postMessage(credential, { channel: chat, threadTs: target.th, text: `<@${user}> only the people this agent talks to can approve its tools.` });
    return;
  }
  const session = agentStore.getSession(target.s);
  const call = session?.pending?.calls.find((c) => c.callId === target.c);
  if (!session || !call) return;
  if (chat && ts) {
    const name = found.agent.published?.config.name ?? found.agent.name;
    await updateMessage(credential, {
      channel: chat,
      ts,
      text: `${call.tool}: ${approved ? 'approved' : 'rejected'}`,
      blocks: decidedBlocks({ title: `${name} wants to run a tool`, tool: call.tool, input: call.input, approved, ...(user && { user }) }),
    }).catch((caught: Error) => logger.warn('could not update the Slack approval message', { error: caught.message }));
  }
  const outcome = await decide(found.agent, target.s, target.c, approved, { ...(user && { by: `slack:${user}` }) });
  if (outcome.status === 'resumed' && chat) await deliver(found.agent, found.channel, credential, chat, target.th, outcome);
}

