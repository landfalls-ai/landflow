/**
 * What Slack sends to Landflow:
 *
 * - Events API, per agent channel: POST /api/slack/events/<agentId>/<channelId>. The app's Request URL. Verified
 *   with the channel credential's signing secret; `url_verification` answers the challenge; `app_mention` and
 *   direct messages (`message` with `channel_type: im`) run the published agent and the reply goes back in the
 *   message's thread (each thread is a session). Retries (`X-Slack-Retry-Num`) and repeated event ids are
 *   ignored, and the event is acknowledged at once: Slack wants a 200 within 3 seconds.
 * - Slash commands, per agent channel: POST /api/slack/commands/<agentId>/<channelId>. Signed like events; acknowledged at once
 *   (Slack wants a response within 3 seconds) and answered later by posting the agent's reply to the command's `response_url`.
 *   One session per user and Slack channel; `/<command> new` starts over.
 * - Interactivity: POST /api/slack/interactions. The approval buttons of AI Agent nodes (workflow executions)
 *   and of agents answering in Slack. Checked against every Slack credential's signing secret; the
 *   credential that verifies must be the one that posted the buttons.
 *
 * Tools that need approval pause the agent and post Approve / Reject buttons in the thread; the click decides
 * (lib/server/agents/runtime.ts `decide`) and the run continues.
 */
import type { JsonObject } from '@landflow/protocol';
import { approvalSubject, type Agent, type AgentChannel } from '../../shared/agents';
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
  EDIT_ACTION,
  EDIT_MODAL,
  editModal,
  slackCall,
  decidedBlocks,
  escape,
  inBackground,
  parseTarget,
  postMessage,
  postResponseUrl,
  REJECT_ACTION,
  slackCredentialFor,
  slackRefOf,
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
    credential = await slackCredentialFor(found.channel.credential);
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
  await deliver(agent, channel, threadPost(credential, chat, threadTs), chat, threadTs, result);
}

/** Where a run's outcome goes: a thread or channel through the bot token, or a slash command's `response_url`. */
type Post = (message: { text: string; blocks?: JsonObject[] }) => Promise<unknown>;

const threadPost =
  (credential: SlackCredential, chat: string, threadTs: string | undefined): Post =>
  (message) =>
    postMessage(credential, { channel: chat, threadTs, ...message });

/** Post the run's outcome: the reply, or one Approve / Reject message per call that waits. */
async function deliver(agent: Agent, channel: AgentChannel, post: Post, chat: string, threadTs: string | undefined, result: RunResult, command = false) {
  if (result.reason === 'awaiting_approval' && result.session.pending) {
    const name = agent.published?.config.name ?? agent.name;
    for (const call of result.session.pending.calls.filter((c) => !c.decision)) {
      const target: ApprovalTarget = { t: 'agent', a: agent.id, ch: channel.id, s: result.session.id, c: call.callId, ...(threadTs && { th: threadTs }), ...(command && { cmd: chat }) };
      await post({ text: `${name}: approve ${call.tool}?`, blocks: approvalBlocks({ title: `${name} wants to run a tool`, ...approvalSubject(call), target }) });
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
  await post({ text: reply });
}

/** After an approval decided elsewhere (an emailed link) resumed a Slack session: the answer goes back where the conversation is. */
export async function deliverResumedSlack(agent: Agent, outcome: RunResult) {
  const [kind, channelId, chat, threadTs] = (outcome.session.conversationKey ?? '').split(':');
  const channel = agentChannel(agent.id, channelId ?? '')?.channel;
  if ((kind !== 'slack' && kind !== 'slackcmd') || !channel || !chat) return;
  const credential = await slackCredentialFor(channel.credential);
  await deliver(agent, channel, threadPost(credential, chat, kind === 'slack' ? threadTs : undefined), chat, kind === 'slack' ? threadTs : undefined, outcome, kind === 'slackcmd');
}

/** POST /api/slack/commands/<agentId>/<channelId>: a slash command (form-encoded) of the Slack app. */
export async function handleSlackCommand(request: Request, agentId: string, channelId: string): Promise<Response> {
  const raw = await request.text();
  const found = agentChannel(agentId, channelId);
  if (!found) return error('No published agent has this Slack channel', 404);
  let credential: SlackCredential;
  try {
    credential = await slackCredentialFor(found.channel.credential);
  } catch (caught) {
    return error((caught as Error).message, 500);
  }
  if (!credential.signingSecret) return error('Set the Signing Secret on the Slack credential: Landflow refuses unverified Slack requests', 401);
  const verified = verifySlackRequest(credential.signingSecret, request.headers, raw);
  if (!verified.ok) return error(verified.reason, 401);

  const form = new URLSearchParams(raw);
  const command = form.get('command') ?? '/ask';
  const text = (form.get('text') ?? '').trim();
  const user = form.get('user_id') ?? '';
  const chat = form.get('channel_id') ?? '';
  const responseUrl = form.get('response_url') ?? '';
  const ephemeral = (message: string) => json({ response_type: 'ephemeral', text: message });
  if (!user || !chat || !/^https?:\/\//i.test(responseUrl)) return error('Not a Slack slash command request', 400);
  if (!found.channel.enabled || found.channel.slashCommands === false) return ephemeral('Slash commands are turned off for this agent.');
  if (!allowed(found.channel, { id: user })) {
    logger.warn('slack command from a user not on the allow list', { 'gen_ai.agent.id': agentId, 'landflow.slack.user': user });
    return ephemeral('Sorry, this agent only talks to people its owner allowed.');
  }
  // Slack does not retry commands, but a double submit or a proxy retry carries the same trigger id.
  if (!firstTime(form.get('trigger_id') ?? undefined)) return new Response(null, { status: 200 });
  if (!text) return ephemeral(`Ask me something: \`${command} <your question>\`. \`${command} new\` starts a new conversation.`);

  // Acknowledge now (Slack gives 3 seconds); the answer follows on the response_url.
  inBackground(
    () => answerCommand(found.agent, found.version, found.channel, { command, text, user, chat, responseUrl }),
    async (caught) => {
      logger.warn('slack command failed', { 'gen_ai.agent.id': agentId, error: (caught as Error).message });
      await postResponseUrl(responseUrl, { response_type: 'ephemeral', text: 'Something went wrong while answering. Please try again.' }).catch(() => undefined);
    },
  );
  return new Response(null, { status: 200 });
}

interface CommandCall {
  command: string;
  text: string;
  user: string;
  chat: string;
  responseUrl: string;
}

/** One session per user and Slack channel: follow-up commands keep the context. */
async function answerCommand(agent: Agent, version: number, channel: AgentChannel, call: CommandCall) {
  const key = `slackcmd:${channel.id}:${call.chat}:${call.user}`;
  const userId = `slack:${call.user}`;
  if (['new', 'reset'].includes(call.text.toLowerCase())) {
    agentStore.saveSession(newSession(agent, { source: 'slack', userId, version, conversationKey: key, title: 'New conversation' }));
    await postResponseUrl(call.responseUrl, { response_type: 'ephemeral', text: 'Started a new conversation.' });
    return;
  }
  let session = agentStore.findConversation(agent.id, key);
  const idleMinutes = channel.newSessionAfterMinutes;
  if (session && idleMinutes > 0 && Date.now() - Date.parse(session.updatedAt) > idleMinutes * 60_000) session = undefined;
  if (session && session.version !== version) session = { ...session, version };
  if (session?.status === 'awaiting_approval') {
    await postResponseUrl(call.responseUrl, { response_type: 'ephemeral', text: 'I’m waiting for an approval of my last request first.' });
    return;
  }
  session ??= newSession(agent, { source: 'slack', userId, version, conversationKey: key, title: call.text.slice(0, 80) });
  const result = await runAgent({ agent, session, message: call.text, approvals: 'ask', rootTrace: true });
  // The command is not echoed into the channel by Slack: say who asked what, then answer.
  const heading = `<@${call.user}> ran \`${escape(call.command)} ${escape(call.text.length > 200 ? `${call.text.slice(0, 200)}…` : call.text)}\``;
  const post: Post = (message) => postResponseUrl(call.responseUrl, { response_type: 'in_channel', ...message, ...(message.blocks ? {} : { text: `${heading}\n${message.text}` }) });
  await deliver(agent, channel, post, call.chat, undefined, result, true);
}

interface InteractionPayload {
  type?: string;
  user?: { id?: string; username?: string };
  channel?: { id?: string };
  container?: { channel_id?: string; message_ts?: string; thread_ts?: string };
  message?: { ts?: string; thread_ts?: string };
  actions?: Array<{ action_id?: string; value?: string }>;
  response_url?: string;
  trigger_id?: string;
  /** A submitted modal (Ask a Person's Edit). */
  view?: { callback_id?: string; private_metadata?: string; state?: { values?: Record<string, Record<string, { value?: string | null }>> } };
}

/** POST /api/slack/interactions */
export async function handleSlackInteraction(request: Request): Promise<Response> {
  const raw = await request.text();
  const candidates = await slackCredentialsWithSecret();
  if (!candidates.length) return error('No Slack credential has a Signing Secret: Landflow refuses unverified Slack requests', 401);
  const verifiedBy = new Set(candidates.filter((c) => verifySlackRequest(c.credential.signingSecret!, request.headers, raw).ok).map((c) => c.id));
  if (!verifiedBy.size) return error('Invalid Slack signature', 401);

  let payload: InteractionPayload;
  try {
    payload = JSON.parse(new URLSearchParams(raw).get('payload') ?? '');
  } catch {
    return error('Expected a form body with a payload', 400);
  }
  if (payload.type === 'view_submission') return submitEdit(payload, verifiedBy);
  if (payload.type !== 'block_actions') return new Response(null, { status: 200 });
  const action = payload.actions?.find((a) => a.action_id === APPROVE_ACTION || a.action_id === REJECT_ACTION || a.action_id === EDIT_ACTION);
  const target = parseTarget(action?.value);
  if (!action || !target) return new Response(null, { status: 200 });
  const user = payload.user?.id;
  if (action.action_id === EDIT_ACTION) {
    if (target.t === 'wf') inBackground(() => openEditor(target, payload.trigger_id, user, verifiedBy), (caught) => logger.warn('slack edit failed', { error: (caught as Error).message }));
    return new Response(null, { status: 200 });
  }
  const approved = action.action_id === APPROVE_ACTION;
  const chat = payload.container?.channel_id ?? payload.channel?.id;
  const ts = payload.container?.message_ts ?? payload.message?.ts;
  inBackground(
    () => (target.t === 'wf' ? decideWorkflow(target, approved, user, verifiedBy) : decideAgent(target, approved, user, verifiedBy, chat, ts, payload.response_url)),
    (caught) => logger.warn('slack approval failed', { error: (caught as Error).message }),
  );
  return new Response(null, { status: 200 });
}

/** The Slack credential of the node an Ask a Person request belongs to, if the click was signed by that app. */
async function confirmCredential(target: Extract<ApprovalTarget, { t: 'wf' }>, verifiedBy: Set<string>) {
  const record = store.getExecution(target.e);
  const approval = pendingApproval(record);
  const node = record?.workflow?.nodes.find((n) => n.id === approval?.nodeId || n.name === approval?.nodeName);
  const ref = slackRefOf(node?.credentials)?.ref;
  if (!approval?.confirm || !ref) return undefined;
  if (!verifiedBy.has(ref.id)) throw new Error('The edit was signed by another Slack app than the one that asked');
  return { credential: await slackCredentialFor(ref), approval };
}

/** Edit: a modal with the draft, opened with the click's trigger id (valid for three seconds). */
async function openEditor(target: Extract<ApprovalTarget, { t: 'wf' }>, triggerId: string | undefined, user: string | undefined, verifiedBy: Set<string>) {
  if (!triggerId) return;
  const found = await confirmCredential(target, verifiedBy);
  if (!found || found.approval.decisions?.[target.c]) return;
  const allowed = found.approval.confirm!.approvers;
  if (user && allowed?.length && !allowed.some((a) => a.toLowerCase() === user.toLowerCase())) return;
  const text = found.approval.calls.find((c) => c.id === target.c)?.input?.text;
  await slackCall(found.credential, 'views.open', { trigger_id: triggerId, view: editModal({ text: typeof text === 'string' ? text : '', meta: JSON.stringify(target) }) });
}

/** A submitted Edit modal: approve with the person's text and comment. An empty text keeps the modal open with the error. */
async function submitEdit(payload: InteractionPayload, verifiedBy: Set<string>): Promise<Response> {
  if (payload.view?.callback_id !== EDIT_MODAL) return new Response(null, { status: 200 });
  const target = parseTarget(payload.view.private_metadata);
  if (target?.t !== 'wf') return new Response(null, { status: 200 });
  const values = payload.view.state?.values ?? {};
  const text = values.text?.text?.value ?? '';
  const comment = values.comment?.comment?.value?.trim();
  if (!text.trim()) return json({ response_action: 'errors', errors: { text: 'The text can’t be empty.' } });
  const user = payload.user?.id;
  inBackground(
    async () => {
      if (!(await confirmCredential(target, verifiedBy))) return;
      const outcome = await decideApproval(target.e, target.c, true, { ...(user && { slackUser: user }), text, ...(comment && { comment }) });
      logger.info('slack edit decided', { 'landflow.execution.id': target.e, 'landflow.approval.status': outcome.status });
    },
    (caught) => logger.warn(caught instanceof ApprovalError ? 'slack edit refused' : 'slack edit failed', { 'landflow.execution.id': target.e, error: (caught as Error).message }),
  );
  return new Response(null, { status: 200 });
}

async function decideWorkflow(target: Extract<ApprovalTarget, { t: 'wf' }>, approved: boolean, user: string | undefined, verifiedBy: Set<string>) {
  // The credential that verified the click must be the node's (one Slack app can't decide another's approvals).
  const record = store.getExecution(target.e);
  const approval = pendingApproval(record) ?? (record?.wait?.data?.approval as { nodeName?: string; nodeId?: string } | undefined);
  const node = record?.workflow?.nodes.find((n) => n.id === approval?.nodeId || n.name === approval?.nodeName);
  const ref = slackRefOf(node?.credentials)?.ref;
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
  responseUrl: string | undefined,
) {
  const found = agentChannel(target.a, target.ch);
  if (!found || !verifiedBy.has(found.channel.credential.id)) throw new Error('The approval does not belong to a Slack channel of a published agent');
  const credential = await slackCredentialFor(found.channel.credential);
  if (!allowed(found.channel, user ? { id: user } : null)) {
    if (chat) await postMessage(credential, { channel: chat, threadTs: target.th, text: `<@${user}> only the people this agent talks to can approve its tools.` });
    return;
  }
  const session = agentStore.getSession(target.s);
  const call = session?.pending?.calls.find((c) => c.callId === target.c);
  if (!session || !call) return;
  const name = found.agent.published?.config.name ?? found.agent.name;
  const decidedMessage = { text: `${call.tool}: ${approved ? 'approved' : 'rejected'}`, blocks: decidedBlocks({ title: `${name} wants to run a tool`, tool: call.tool, input: call.input, approved, ...(user && { user }) }) };
  // An approval asked inside a slash command's session answers through the click's own response_url: the bot may not be in that channel.
  const viaUrl = target.cmd && responseUrl;
  if (viaUrl) {
    await postResponseUrl(responseUrl, { replace_original: true, ...decidedMessage }).catch((caught: Error) => logger.warn('could not update the Slack approval message', { error: caught.message }));
  } else if (chat && ts) {
    await updateMessage(credential, { channel: chat, ts, ...decidedMessage }).catch((caught: Error) => logger.warn('could not update the Slack approval message', { error: caught.message }));
  }
  const outcome = await decide(found.agent, target.s, target.c, approved, { ...(user && { by: `slack:${user}` }) });
  if (outcome.status !== 'resumed' || !chat) return;
  const post: Post = viaUrl ? (message) => postResponseUrl(responseUrl, { response_type: 'in_channel', ...message }) : threadPost(credential, chat, target.th);
  await deliver(found.agent, found.channel, post, chat, target.th, outcome, Boolean(target.cmd));
}

