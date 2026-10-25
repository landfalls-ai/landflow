/**
 * What starts a published agent besides the test chat: schedules (checked once a minute, in each
 * schedule's time zone) and chat channels. The Telegram channel polls getUpdates through the
 * messaging plugin's Telegram Trigger (mode "poll", like the workflow poller) and answers with its
 * Telegram node, so the bot token stays in the vault and the plugin owns the API. Runs here never
 * pause for approvals: nobody is watching, so tools that need one are refused.
 */
import { nanoid } from 'nanoid';
import { defaultVersionOf, PROTOCOL_VERSION, type ExecuteRequest, type JsonObject, type NodeItem } from '@landflow/protocol';
import type { Agent, AgentChannel, AgentSchedule } from '../../shared/agents';
import { credentials } from '../credentials/vault';
import { registry } from '../plugins/registry';
import { singleton } from '../singleton';
import { logger } from '../telemetry';
import { isDue } from './cron';
import { newSession, runAgent } from './runtime';
import { agentStore } from './store';

const CHANNEL_POLL_MS = Math.max(2, Number(process.env.LANDFLOW_AGENT_CHANNEL_POLL_SECONDS ?? 5)) * 1_000;
const TELEGRAM_TRIGGER = 'messaging.telegramTrigger';
const TELEGRAM = 'messaging.telegram';
const TELEGRAM_CREDENTIAL = 'messaging.telegramApi';
/** Telegram rejects longer messages. */
const TELEGRAM_MAX_CHARS = 4_000;

/** Published agents with the config they run on. */
function published(): Array<{ agent: Agent; config: NonNullable<Agent['published']>['config']; version: number }> {
  return agentStore.list().flatMap((agent) => (agent.published ? [{ agent, config: agent.published.config, version: agent.published.version }] : []));
}

export async function runSchedule(agent: Agent, version: number, schedule: AgentSchedule) {
  const session = newSession(agent, { source: 'schedule', userId: `schedule:${schedule.id}`, version, title: schedule.prompt.slice(0, 80) });
  const result = await runAgent({ agent, session, message: schedule.prompt, approvals: 'deny', rootTrace: true });
  logger.info('agent schedule ran', { 'gen_ai.agent.id': agent.id, 'landflow.agent.schedule.id': schedule.id, 'landflow.agent.end_reason': result.reason });
  return result;
}

async function callTelegram(agent: Agent, channel: AgentChannel, nodeType: string, parameters: JsonObject, pollState?: JsonObject) {
  const resolved = registry.resolve(nodeType);
  if ('error' in resolved) throw new Error(`${resolved.error} — the Telegram channel needs the messaging plugin`);
  const poll = nodeType === TELEGRAM_TRIGGER;
  const request: ExecuteRequest = {
    protocol: PROTOCOL_VERSION,
    executionId: `agch_${nanoid(10)}`,
    workflowId: `agent:${agent.id}`,
    mode: poll ? 'poll' : 'trigger',
    node: { id: channel.id, name: 'Telegram', type: nodeType, typeVersion: defaultVersionOf(resolved.descriptor) },
    parameters,
    itemParameters: poll ? [] : [parameters],
    inputs: poll ? [] : [[{ json: {} }]],
    credentials: { telegramApi: credentials.dataFor(channel.credential, TELEGRAM_CREDENTIAL) },
    ...(pollState && { pollState }),
  };
  const response = await resolved.execute(request, { signal: AbortSignal.timeout(30_000) });
  if (response.error) throw new Error([response.error.message, response.error.description].filter(Boolean).join(' — '));
  return response;
}

function chunks(text: string): string[] {
  const parts: string[] = [];
  let rest = text.trim() || '(no reply)';
  while (rest.length > TELEGRAM_MAX_CHARS) {
    const cut = Math.max(rest.lastIndexOf('\n', TELEGRAM_MAX_CHARS), TELEGRAM_MAX_CHARS / 2);
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  return [...parts, rest];
}

const send = async (agent: Agent, channel: AgentChannel, chatId: string, text: string) => {
  for (const part of chunks(text)) {
    await callTelegram(agent, channel, TELEGRAM, { resource: 'message', operation: 'sendMessage', chatId, text: part, additionalFields: {} });
  }
};

/** Private channels answer only the listed Telegram user ids or @usernames, or Slack member ids. */
export function allowed(channel: Pick<AgentChannel, 'access' | 'allowedUsers'>, from: { id?: number | string; username?: string } | null): boolean {
  if (channel.access === 'public') return true;
  if (!from) return false;
  const users = channel.allowedUsers.map((u) => u.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
  // Slack member ids are upper case (U0123ABC); the list is compared in lower case.
  return users.includes(String(from.id).toLowerCase()) || (from.username !== undefined && users.includes(from.username.toLowerCase()));
}

async function handleUpdate(agent: Agent, version: number, channel: AgentChannel, item: NodeItem) {
  const update = item.json as { text?: string | null; chat?: { id?: number | string } | null; from?: { id?: number; username?: string; first_name?: string } | null };
  const chatId = update.chat?.id;
  if (chatId === undefined || chatId === null) return;
  const text = typeof update.text === 'string' ? update.text.trim() : '';
  if (!allowed(channel, update.from ?? null)) {
    await send(agent, channel, String(chatId), 'Sorry, this agent only talks to people its owner allowed.');
    logger.warn('telegram message from a user not on the allow list', { 'gen_ai.agent.id': agent.id, 'landflow.telegram.user': String(update.from?.id ?? 'unknown') });
    return;
  }
  if (!text) {
    await send(agent, channel, String(chatId), 'I can only read text messages for now.');
    return;
  }
  const key = `telegram:${channel.id}:${chatId}`;
  const command = text.split(/\s|@/)[0].toLowerCase();
  if (command === '/start' || command === '/new') {
    const fresh = newSession(agent, { source: 'telegram', userId: `telegram:${update.from?.id ?? chatId}`, version, conversationKey: key, title: 'New conversation' });
    agentStore.saveSession(fresh);
    await send(agent, channel, String(chatId), command === '/start' ? `Hi${update.from?.first_name ? ` ${update.from.first_name}` : ''}! I'm ${agent.published?.config.name ?? agent.name}. ${agent.published?.config.description ?? ''}`.trim() : 'Started a new conversation.');
    return;
  }
  let session = agentStore.findConversation(agent.id, key);
  const idleMinutes = channel.newSessionAfterMinutes;
  if (session && idleMinutes > 0 && Date.now() - Date.parse(session.updatedAt) > idleMinutes * 60_000) session = undefined;
  // A conversation started on an older version moves to the current one.
  if (session && session.version !== version) session = { ...session, version };
  session ??= newSession(agent, { source: 'telegram', userId: `telegram:${update.from?.id ?? chatId}`, version, conversationKey: key });
  void callTelegram(agent, channel, TELEGRAM, { resource: 'message', operation: 'sendChatAction', chatId: String(chatId), action: 'typing' }).catch(() => {});
  const result = await runAgent({ agent, session, message: text, approvals: 'deny', rootTrace: true });
  const reply =
    result.reply ??
    (result.reason === 'budget'
      ? 'This conversation reached its token budget. Send /new to start over.'
      : result.reason === 'max_iterations'
        ? 'I couldn’t finish that within my step limit. Try a narrower request.'
        : 'Something went wrong while answering. Please try again.');
  await send(agent, channel, String(chatId), reply);
}

async function pollChannel(agent: Agent, version: number, channel: AgentChannel) {
  const key = `${agent.id}:${channel.id}:${channel.credential.id}`;
  const state = agentStore.channelState(key);
  const response = await callTelegram(agent, channel, TELEGRAM_TRIGGER, { updates: ['message'], pollInterval: CHANNEL_POLL_MS / 1000 }, state);
  // Save the offset first: a crash mid-answer must not replay the message.
  if (response.pollState) agentStore.setChannelState(key, response.pollState);
  // The first poll only sets the baseline, like the workflow poller.
  const items = state ? (response.outputs[0] ?? []) : [];
  for (const item of items) {
    try {
      await handleUpdate(agent, version, channel, item);
    } catch (error) {
      logger.warn('telegram message failed', { 'gen_ai.agent.id': agent.id, error: (error as Error).message });
    }
  }
}

export const agentTriggers = singleton('agent-triggers', () => {
  const inFlight = new Set<string>();
  const lastPoll = new Map<string, number>();
  const failing = new Map<string, string>();
  let lastMinute = '';
  let timer: NodeJS.Timeout | undefined;

  const once = (key: string, work: () => Promise<unknown>) => {
    if (inFlight.has(key)) return;
    inFlight.add(key);
    void work()
      .then(() => failing.delete(key))
      .catch((error: Error) => {
        // Log a failure once, not on every poll.
        if (failing.get(key) !== error.message) logger.warn('agent trigger failed', { 'landflow.agent.trigger': key, error: error.message });
        failing.set(key, error.message);
      })
      .finally(() => inFlight.delete(key));
  };

  function tick() {
    const now = new Date();
    const minute = now.toISOString().slice(0, 16);
    const newMinute = minute !== lastMinute;
    lastMinute = minute;
    for (const { agent, config, version } of published()) {
      if (newMinute) {
        for (const schedule of config.schedules) {
          if (!schedule.enabled || !schedule.prompt.trim()) continue;
          let due = false;
          try {
            due = isDue(schedule, now);
          } catch (error) {
            if (failing.get(schedule.id) !== (error as Error).message) logger.warn('invalid agent schedule', { 'gen_ai.agent.id': agent.id, error: (error as Error).message });
            failing.set(schedule.id, (error as Error).message);
          }
          if (due) once(`schedule:${agent.id}:${schedule.id}`, () => runSchedule(agent, version, schedule));
        }
      }
      for (const channel of config.channels) {
        if (!channel.enabled || channel.type !== 'telegram') continue;
        const key = `channel:${agent.id}:${channel.id}`;
        if (Date.now() - (lastPoll.get(key) ?? 0) < CHANNEL_POLL_MS) continue;
        lastPoll.set(key, Date.now());
        once(key, () => pollChannel(agent, version, channel));
      }
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, 1_000);
      timer.unref?.();
    },
    /** Stop the triggers (queue mode: this main no longer leads). */
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
    /** Last error per trigger, for the builder. */
    errors: () => Object.fromEntries(failing),
  };
});
