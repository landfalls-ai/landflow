/**
 * Wave ag3 carryover (the live pass, triage agent): "send the email from landflow@landflow.test" under Spotlight's card, and
 * "set Send Email's From Email to …" on the created agent, changed only the description or nothing ("No change"), because a
 * revise keeps the base's own tools as they are and the design's flat proposal carries no parameters. A change that gives a
 * kept mail tool its sender now sets an empty From to that address, says so in the Changes row and drops the "fill in From
 * Email" need; a From the person already set is never rewritten, and a change with two senders or none sets nothing.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { agentChanges } from '@/lib/shared/agent-changes';
import { DEFAULT_BRIEF_GUARDRAILS, type AgentConfig } from '@/lib/shared/agents';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { startFakeModels } from './fake-ai-services';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-revise-sender-ag3-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { plugin: triage } = await import('../../../plugins/triage/src/main');
const { plugin: messaging } = await import('../../../plugins/messaging/src/main');

const post = (body: unknown) => import('@/app/api/agents/design/route').then(({ POST }) => POST(new Request('http://localhost/api/agents/design', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })));

const STEPS = 'Input: an alert.\nSteps:\n1. Normalise it with normalize_alert.\n2. Email a short summary to oncall@landflow.test with send_email.\n3. Tools: normalize_alert, send_email; read before you write, and a person approves each change.\nOutput: a short summary.\nHand over when: it cannot tell.';
const base = (fromEmail?: string): Partial<AgentConfig> => ({
  name: 'Alert triager',
  description: 'Triages an alert and emails a summary to oncall@landflow.test.',
  instructions: STEPS,
  icon: 'bot',
  color: '#6366f1',
  avatar: { kind: 'face', face: 'ada' } as never,
  model: { provider: 'ollama', model: 'qwen3-coder:30b' },
  tools: [
    { id: 'tl_1', type: 'node', name: 'normalize_alert', description: 'Normalise an alert.', nodeType: 'triage.normalizeAlert', parameters: {} } as never,
    { id: 'tl_2', type: 'node', name: 'send_email', description: 'Send an email.', nodeType: 'messaging.emailSend', parameters: { toEmail: 'oncall@landflow.test', ...(fromEmail !== undefined && { fromEmail }) }, requireApproval: true } as never,
  ],
  skills: [],
  schedules: [],
  channels: [],
  memory: { crossSession: false },
  settings: {} as never,
  guardrails: DEFAULT_BRIEF_GUARDRAILS,
});

/** A fake Ollama whose flat proposal keeps the same two tools and the same steps (it can carry no parameters). */
async function proposing() {
  const fake = await startFakeModels({
    reply: (_provider, body) =>
      Array.isArray((body as { messages?: unknown })?.messages)
        ? { text: '', toolCalls: [{ id: 'c1', name: 'propose_design', arguments: { summary: 'x', role: 'Triager', instructions: STEPS, description: 'Triages an alert and emails a summary to oncall@landflow.test.', model: 'ollama/qwen3-coder:30b', nodeTools: 'triage.normalizeAlert, messaging.emailSend' } }] }
        : { text: '', toolCalls: [] },
  });
  const previous = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = fake.origin;
  return {
    done: async () => {
      if (previous === undefined) delete process.env.OLLAMA_URL;
      else process.env.OLLAMA_URL = previous;
      await fake.close();
    },
  };
}

type Body = { config: AgentConfig; changes: string[]; needs: Array<{ tool: string; kind: string; text: string }> };
const sendEmail = (config: AgentConfig) => config.tools.find((t) => 'name' in t && t.name === 'send_email') as { parameters?: Record<string, unknown> } | undefined;
const fromNeed = (body: Body) => body.needs.some((n) => n.tool === 'send_email' && /from email/i.test(n.text));

beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  for (const plugin of [triage, messaging]) registry.registerBuiltin(plugin);
});

describe('a change that gives the sender sets an empty From', () => {
  it.each(['send the email from landflow@landflow.test', "set Send Email's From Email to landflow@landflow.test", 'send it from the address landflow@landflow.test', /* ag5 carryover (live G2): the chat's change text for “Send the email from landflow@landflow.test.” */ "Set send_email's fixed fromEmail parameter to landflow@landflow.test. Keep toEmail oncall@landflow.test. Add no other tool or knowledge."])('"%s" sets From, says so and drops the From need', async (change) => {
    const run = await proposing();
    try {
      const before = (await (await post({ name: 'Alert triager', preview: true, base: { config: base() }, change: 'also make sure it emails the summary with Send Email' })).json()) as Body;
      expect(fromNeed(before)).toBe(true);
      const body = (await (await post({ name: 'Alert triager', preview: true, base: { config: base() }, change })).json()) as Body;
      expect(sendEmail(body.config)?.parameters).toMatchObject({ fromEmail: 'landflow@landflow.test', toEmail: 'oncall@landflow.test' });
      expect(body.changes).toContain('Send Email: From Email set to landflow@landflow.test');
      expect(fromNeed(body)).toBe(false);
    } finally {
      await run.done();
    }
  });

  it('a From the person already set is never rewritten', async () => {
    const run = await proposing();
    try {
      const body = (await (await post({ name: 'Alert triager', preview: true, base: { config: base('me@landflow.test') }, change: 'send the email from landflow@landflow.test' })).json()) as Body;
      expect(sendEmail(body.config)?.parameters?.fromEmail).toBe('me@landflow.test');
      expect(body.changes.some((c) => /From Email/.test(c))).toBe(false);
    } finally {
      await run.done();
    }
  });

  it('no sender, or two different ones, sets nothing (and keeps the need where the design lists it)', async () => {
    const run = await proposing();
    try {
      for (const change of ['send the email to oncall@landflow.test', 'send it from a@landflow.test or from b@landflow.test']) {
        const body = (await (await post({ name: 'Alert triager', preview: true, base: { config: base() }, change })).json()) as Body;
        expect(sendEmail(body.config)?.parameters?.fromEmail ?? '', change).toBe('');
        // the need is the design's: a change that says to email keeps "fill in From Email" (a change that only names a sender
        // proposes no write, so the design lists no need for the kept tool, as before)
        if (/\bto oncall@/.test(change)) expect(fromNeed(body), change).toBe(true);
      }
    } finally {
      await run.done();
    }
  });
});

describe('agentChanges says a value set on a kept tool', () => {
  it('names the field and the value; a $fromAI value or one that was set already says nothing', () => {
    const tool = (parameters: Record<string, unknown>) => ({ tools: [{ type: 'node', name: 'send_email', nodeType: 'messaging.emailSend', parameters }] });
    expect(agentChanges(tool({}), tool({ fromEmail: 'landflow@landflow.test' }))).toEqual(['Send Email: From Email set to landflow@landflow.test']);
    expect(agentChanges(tool({}), tool({ subject: "{{ $fromAI('subject', 'The email subject', 'string') }}" }))).toEqual([]);
    expect(agentChanges(tool({ fromEmail: 'me@landflow.test' }), tool({ fromEmail: 'me@landflow.test' }))).toEqual([]);
  });
});

describe("the created card's Left row follows a field set on the draft", () => {
  it('drops "fill in From Email" once the draft\'s Send Email has a From, keeps it while empty, and keeps other lines', async () => {
    const { stillLeft } = await import('@/lib/client/agent-change');
    const lines = ['send_email: pick a smtp credential (you have “Mailpit SMTP”)', 'send_email: fill in From Email', 'http_request: set URL (the request gives none)', 'Pick a model: none'];
    const empty = { tools: [{ name: 'send_email', parameters: { fromEmail: '' } }, { name: 'http_request', parameters: {} }] };
    expect(stillLeft(lines, empty)).toEqual(lines);
    const set = { tools: [{ name: 'send_email', parameters: { fromEmail: 'landflow@landflow.test' }, credentials: { smtp: { id: 'c' } } }, { name: 'http_request', parameters: { url: 'http://127.0.0.1:1/x' } }] };
    expect(stillLeft(lines, set)).toEqual(['Pick a model: none']);
  });
});
