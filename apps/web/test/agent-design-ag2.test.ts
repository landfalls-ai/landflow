/**
 * AG08 (wave ag2): a design fills a tool's settings honestly and writes real test cases. Send Email goes to the ask's address
 * with a subject and body the agent writes per call, a destination nobody gave is left empty and asked for, a required
 * property the model fills per call is no need, the cases are inputs a person would send, and a node tool takes only the
 * arguments its schema offered. The model is scripted; nothing leaves this machine.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, LanguageModel, ModelTurn } from '@landflow/engine';
import { deriveToolSchema } from '@landflow/engine';
import type { NodeToolConfig } from '@/lib/shared/agents';
import type { NodeTypeInfo } from '@/lib/shared/types';

vi.setConfig({ testTimeout: 30_000 });

const { corePlugin } = await import('@/lib/server/nodes');
const { registry } = await import('@/lib/server/plugins/registry');
const { draftFrom, parseCases, describesCase } = await import('@/lib/server/assistant/architect');
const { runArchitect } = await import('@/lib/server/assistant/architect');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { prepare, addScenarioPlugins } = await import('./spotlight-scenarios/harness');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession } = await import('@/lib/server/agents/runtime');
const { buildToolset } = await import('@/lib/server/agents/tools');
const { credentials } = await import('@/lib/server/credentials/vault');

const TRIAGE_ASK = 'Create an agent that triages an alert: normalize it, extract the IOCs and email a short summary to oncall@landflow.test. Never email anyone else. Use the Normalize Alert, Extract IOCs and Send Email tools.';
const GRAFANA_ASK = 'Create an agent that lists the firing alerts in Grafana and explains what each one means. Use the Get Alerts and Get Alert Details tools.';

let types: NodeTypeInfo[];
beforeAll(async () => {
  prepare();
  registry.registerBuiltin(corePlugin);
  await addScenarioPlugins({ start: { plugins: ['triage', 'messaging', 'grafana'] } }, 'unit');
  types = registry.nodeTypes();
});

const nodeTools = (config: { tools?: unknown[] }) => (config.tools ?? []) as NodeToolConfig[];
const mailArgs = (parameters: Record<string, unknown>) => ({ name: 'Mailer', role: 'Helper', instructions: 'Work.', tools: [{ type: 'node', nodeType: 'messaging.emailSend', name: 'Send Email', description: 'Mail it', parameters }] });
const draft = (args: unknown, request: string) => draftFrom(args as never, { types, actor: TEST_OWNER, known: '', request });
const mailOf = (result: ReturnType<typeof draftFrom>) => nodeTools(result.config).find((t) => t.nodeType === 'messaging.emailSend')!;

describe('Send Email: the ask’s address, a subject and a body the agent writes, a From the person gives', () => {
  it('fills To from the ask and Subject and Text with $fromAI; asks for From and not for To', () => {
    const result = draft(mailArgs({ toEmail: '', fromEmail: '' }), TRIAGE_ASK);
    const mail = mailOf(result);
    expect(mail.parameters.toEmail).toBe('oncall@landflow.test');
    expect(mail.parameters.subject).toBe("{{ $fromAI('subject', 'The email subject', 'string') }}");
    expect(mail.parameters.text).toBe("{{ $fromAI('body', 'The email text', 'string') }}");
    expect(mail.parameters.fromEmail).toBe('');
    const needs = result.needs.map((n) => n.text);
    expect(needs).toContain('send_email: fill in From Email');
    expect(needs.join(' ')).not.toMatch(/To Email/);
    const descriptor = types.find((t) => t.type === 'messaging.emailSend')!.descriptor;
    const schema = deriveToolSchema(descriptor, mail.parameters) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(['body', 'subject']);
  });

  it('replaces a To the ask never gave with the ask’s address, and says so', () => {
    const result = draft(mailArgs({ toEmail: 'team@example.com' }), TRIAGE_ASK);
    expect(mailOf(result).parameters.toEmail).toBe('oncall@landflow.test');
    expect(result.dropped.join(' ')).toContain('team@example.com');
  });

  it('keeps a From the ask holds and drops one it does not', () => {
    expect(mailOf(draft(mailArgs({ fromEmail: 'alerts@landflow.test' }), `${TRIAGE_ASK} Send it from alerts@landflow.test.`)).parameters.fromEmail).toBe('alerts@landflow.test');
    const invented = draft(mailArgs({ fromEmail: 'noreply@example.com' }), TRIAGE_ASK);
    expect(mailOf(invented).parameters.fromEmail).toBe('');
  });

  it('never makes up an address: an ask with none leaves To empty and asks for it', () => {
    const ask = 'Create an agent that triages an alert and emails a short summary. Use the Send Email tool.';
    const result = draft(mailArgs({ toEmail: 'team@example.com' }), ask);
    const mail = nodeTools(result.config).find((t) => t.nodeType === 'messaging.emailSend');
    expect(mail).toBeDefined();
    expect(mail!.parameters.toEmail).toBe('');
    expect(result.needs.map((n) => n.text).join(' ')).toMatch(/To Email/);
  });
  const toOf = (ask: string, toEmail: string) => nodeTools(draft(mailArgs({ toEmail }), ask).config).find((t) => t.nodeType === 'messaging.emailSend')?.parameters.toEmail;
  it('leaves out an address the person ruled out', () => {
    expect(toOf('Create an agent that emails a short summary to oncall@landflow.test, never to boss@corp.test. Use the Send Email tool.', '')).toBe('oncall@landflow.test');
  });
  it('does not put the sender in To', () => {
    expect(toOf('Create an agent that sends a summary to oncall@landflow.test from alerts@landflow.test. Use the Send Email tool.', '')).toBe('oncall@landflow.test');
  });
  it('keeps a target after a "from <source>" phrase', () => {
    expect(toOf('Create an agent that emails a summary from Grafana to oncall@landflow.test. Use the Send Email tool.', '')).toBe('oncall@landflow.test');
  });
  it('does not put a cc aside in To', () => {
    expect(toOf('Create an agent that emails a summary to oncall@landflow.test (cc me at me@landflow.test only if critical). Use the Send Email tool.', 'oncall@landflow.test')).toBe('oncall@landflow.test');
  });
});

describe('a destination nobody gave', () => {
  const http = (url: string) => ({ name: 'Helper', role: 'Helper', instructions: 'Work.', tools: [{ type: 'node', nodeType: 'core.httpRequest', name: 'HTTP Request', description: 'Fetch', parameters: { url } }] });
  const request = 'Create an agent that checks a status page over HTTP and reports what it says.';
  it('empties a preset URL the ask lacks, says so, and asks for it', () => {
    const result = draft(http('http://127.0.0.1:3000/api/health'), request);
    expect(nodeTools(result.config)[0].parameters.url).toBe('');
    expect(result.dropped.join(' ')).toContain('127.0.0.1:3000');
    expect(result.needs.map((n) => n.text)).toContain('http_request: set URL (the request gives none)');
  });
  it('empties the node’s own default too when the model left the URL out', () => {
    const result = draft({ ...http(''), tools: [{ type: 'node', nodeType: 'core.httpRequest', name: 'HTTP Request', description: 'Fetch' }] }, request);
    expect(nodeTools(result.config)[0].parameters.url).toBe('');
  });
  it('keeps a URL the ask names, whole', () => {
    const result = draft(http('http://127.0.0.1:3440/hook'), `${request} The URL is http://127.0.0.1:3440/hook.`);
    expect(nodeTools(result.config)[0].parameters.url).toBe('http://127.0.0.1:3440/hook');
    expect(result.needs.map((n) => n.text).join(' ')).not.toMatch(/URL/);
  });
});

describe('a property the model fills on each call is not a need', () => {
  const ack = { name: 'Helper', role: 'Helper', instructions: 'Work.', tools: [{ type: 'node', nodeType: 'grafana.acknowledgeAlert', description: 'Acknowledge' }] };
  it('Acknowledge Alert asks for no Alert Name', () => {
    const result = draft(ack, 'Create an agent that lists the firing alerts in Grafana and acknowledges each one in Grafana.');
    expect(nodeTools(result.config).some((t) => t.nodeType === 'grafana.acknowledgeAlert')).toBe(true);
    expect(result.needs.map((n) => n.text).join(' ')).not.toMatch(/Alert Name/);
  });
  it('Send Email still asks for From', () => {
    expect(draft(mailArgs({}), TRIAGE_ASK).needs.map((n) => n.text)).toContain('send_email: fill in From Email');
  });
});

describe('test cases are inputs, not descriptions of them', () => {
  it('drops descriptions and placeholders and keeps an alert’s text', () => {
    const cases = parseCases([
      'Pasted Grafana alert about high CPU on web-01 => Says it is a CPU alert',
      '<alert text> => Summarises it',
      'An email => Is short',
      '[Wazuh] rule 5710 sshd: attempt to login using a non-existent user, src 203.0.113.45 => Names the source address',
    ]);
    expect(cases.map((c) => c.input)).toEqual(['[Wazuh] rule 5710 sshd: attempt to login using a non-existent user, src 203.0.113.45']);
    expect(describesCase('An alert from Wazuh: [Wazuh] rule 5710 sshd, src 203.0.113.45')).toBe(false);
  });

  it('a proposal with only description cases makes one follow-up call, once', async () => {
    let followUps = 0;
    const turns: Array<Partial<ModelTurn>> = [
      { toolCalls: [{ id: 'p1', name: 'propose_agent', input: { summary: 'Draft', name: 'Helper', role: 'Helper', instructions: 'Work.', cases: ['Pasted alert about high CPU => Says so', 'An email => Short', 'A user asks how to reset a password => Explains'] } }] },
      { text: 'Done.' },
    ];
    const model: LanguageModel = {
      provider: 'test',
      model: 'scripted',
      async generate(request) {
        if (typeof request.system === 'string' && request.system.startsWith('You write test cases')) {
          followUps += 1;
          expect(request.system).toContain('written out');
          return { text: 'ALERT cpu_high on web-01 firing for 10m, value 97% => Says CPU is saturated\nHow do I reset my password on the portal? => Explains the reset link\nDisk /var is 95% full on db-02 since 09:00 => Says disk space', toolCalls: [], stopReason: 'stop' as const };
        }
        const next = turns.shift();
        if (!next) throw new Error('No scripted turn left');
        return { text: '', toolCalls: [], stopReason: 'stop', ...next };
      },
    };
    const events: Array<{ type: string; cases?: Array<{ input: string }>; needs?: Array<{ text: string }> }> = [];
    await runArchitect({ actor: TEST_OWNER, messages: [{ role: 'user', content: 'Create an agent that answers questions.' }], types, model, onEvent: (e: never) => events.push(e), resources: { models: [], knowledge: [] } } as never);
    expect(followUps).toBe(1);
    const proposal = events.find((e) => e.type === 'draft')!;
    expect(proposal.cases?.map((c) => c.input)).toEqual(['ALERT cpu_high on web-01 firing for 10m, value 97%', 'How do I reset my password on the portal?', 'Disk /var is 95% full on db-02 since 09:00']);
  });
});

describe('a node tool takes only the arguments its schema offered', () => {
  /** The tool built with the node's execute replaced by one that records the parameters it was called with. */
  async function toolFor(parameters: Record<string, unknown>) {
    const real = registry.resolve.bind(registry);
    const seen: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(registry, 'resolve').mockImplementation(((type: string) => {
      const found = real(type);
      return 'error' in found ? found : { ...found, execute: async (request: { parameters: Record<string, unknown> }) => { seen.push(request.parameters); return { protocol: 1, outputs: [[{ json: {} }]] }; } };
    }) as never);
    const mail = credentials.create({ name: `Local SMTP ${seen.length}`, type: 'messaging.smtp', data: { host: '127.0.0.1', port: 1, secure: false, disableStartTls: true, user: '', password: '' } });
    const config = { id: 't1', type: 'node', name: 'send_email', description: '', nodeType: 'messaging.emailSend', parameters, credentials: { smtp: { id: mail.id, name: mail.name } } } as NodeToolConfig;
    const agent = agentStore.create({ name: 'Mailer', instructions: '', model: { provider: 'ollama', model: 'scripted-1' }, tools: [config] });
    const toolset = await buildToolset(agent, agent);
    spy.mockRestore();
    const ctx = { agent, session: newSession(agent, { source: 'test', userId: 'you', version: 'draft' }), depth: 0, maxDepth: 2, runId: 'run_1', signal: new AbortController().signal } as never;
    return { tool: toolset.tools.find((t) => t.name === 'send_email')!, ctx, seen };
  }
  it('a $fromAI tool ignores a toEmail argument', async () => {
    const { tool, ctx, seen } = await toolFor({ toEmail: 'oncall@landflow.test', subject: "{{ $fromAI('subject') }}", text: "{{ $fromAI('body') }}" });
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toEqual(['subject', 'body']);
    await tool.invoke({ subject: 'S', body: 'B', toEmail: 'evil@example.com' }, ctx);
    expect(seen[0].toEmail).toBe('oncall@landflow.test');
    expect(seen[0].subject).toBe('S');
  });
  it('a heuristic-schema tool still takes its “Optional override”', async () => {
    const { tool, ctx, seen } = await toolFor({ toEmail: 'oncall@landflow.test', subject: 'fixed', text: 'fixed' });
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toContain('toEmail');
    await tool.invoke({ toEmail: 'other@landflow.test' }, ctx);
    expect(seen[0].toEmail).toBe('other@landflow.test');
  });
});
