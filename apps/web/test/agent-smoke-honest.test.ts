/**
 * AG05 (wave ag1): the smoke test says what really happened (docs/assistant.md "Agents and teams", docs/agents.md "Eval gate").
 * A node tool whose visible required credential is unset is `untested` before any model call; a tool that fails or returns
 * nothing fails the test however fluent the reply; a write that needs approval is denied and reported, not a failure.
 * The model is scripted and the tools are stand-ins; nothing leaves this machine.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from '@landflow/engine';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-smoke-honest-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

// The scripted model: the first turn calls `calls`, the next one answers `reply`.
const script = vi.hoisted(() => ({ calls: [] as Array<{ name: string; input: Record<string, unknown> }>, reply: 'All quiet: nothing is firing.', turns: 0 }));
vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:11434',
  modelOptions: async () => [],
  agentModel: (config: { model?: string } | undefined): LanguageModel => {
    if (!config?.model) throw new Error('Choose a model for this agent first');
    return {
      provider: 'scripted',
      model: config.model,
      async generate() {
        script.turns += 1;
        if (script.turns === 1 && script.calls.length) {
          return { text: '', toolCalls: script.calls.map((c, i) => ({ id: `c${i}`, name: c.name, input: c.input })), stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } };
        }
        return { text: script.reply, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
  },
}));

const { defineCredentialType, defineNode, definePlugin } = await import('@landflow/sdk');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { credentials } = await import('@/lib/server/credentials/vault');
const { agentStore } = await import('@/lib/server/agents/store');
const { smokeTest } = await import('@/lib/server/agents/smoke-test');

const behave = vi.hoisted(() => ({ alerts: 'some' as 'some' | 'empty' | 'throws', sent: 0 }));
const base = { kind: 'action' as const, version: 1, inputs: [{ type: 'main' as const }], outputs: [{ type: 'main' as const }] };
registry.registerBuiltin(corePlugin);
registry.registerBuiltin(
  definePlugin({
    info: { id: 'standin', name: 'Stand-ins', version: '0.0.0', language: 'typescript' },
    credentialTypes: [defineCredentialType({ name: 'grafanaApi', displayName: 'Grafana', properties: [{ name: 'token', displayName: 'Token', type: 'string', typeOptions: { password: true } }] })],
    nodes: [
      defineNode({
        description: { ...base, name: 'alerts', displayName: 'Get Alerts', description: 'Firing alerts', credentials: [{ name: 'grafanaApi', required: true }], properties: [] },
        async execute() {
          if (behave.alerts === 'throws') throw new Error('Grafana answered 401. Check the token.');
          return [[{ json: behave.alerts === 'empty' ? {} : { alerts: [{ name: 'CPU high' }] } }]];
        },
      }),
      defineNode({
        // The credential belongs to one auth method only: the default method needs none.
        description: {
          ...base,
          name: 'lookup',
          displayName: 'Lookup',
          description: 'Look something up',
          credentials: [{ name: 'grafanaApi', required: true, displayOptions: { show: { auth: ['token'] } } }],
          properties: [{ name: 'auth', displayName: 'Auth', type: 'string', default: 'none' }],
        },
        async execute() {
          return [[{ json: { found: true } }]];
        },
      }),
      defineNode({
        description: { ...base, name: 'send', displayName: 'Send Email', description: 'Send an email', properties: [] },
        async execute() {
          behave.sent += 1;
          return [[{ json: { sent: true } }]];
        },
      }),
    ],
  }),
);

const node = (name: string, nodeType: string, extra: Record<string, unknown> = {}) => ({ id: `t_${name}`, type: 'node' as const, name, description: name, nodeType, parameters: {}, ...extra });
const makeAgent = (tools: unknown[]) => agentStore.create({ name: 'Watcher', instructions: 'Watch.', model: { provider: 'ollama', model: 'scripted-1' }, tools } as never);

beforeEach(() => {
  Object.assign(script, { calls: [], reply: 'All quiet: nothing is firing.', turns: 0 });
  Object.assign(behave, { alerts: 'some', sent: 0 });
});

describe('the smoke test is honest (AG05)', () => {
  it('is untested, with no model call, while a visible required credential is unset', async () => {
    const agent = makeAgent([node('Get Alerts', 'standin.alerts')]);
    const smoke = await smokeTest(agent.id, 'Which alerts are firing?');
    expect(smoke).toMatchObject({ state: 'untested', reason: 'needs a credential: Get Alerts' });
    expect(script.turns).toBe(0);
  });

  it('names the first and counts the rest', async () => {
    const agent = makeAgent([node('Get Alerts', 'standin.alerts'), node('Other Alerts', 'standin.alerts')]);
    expect((await smokeTest(agent.id, 'Go')).reason).toBe('needs a credential: Get Alerts and 1 more');
  });

  it('runs once the credential is set', async () => {
    const cred = credentials.create({ name: 'Grafana', type: 'standin.grafanaApi', data: { token: 'x' } });
    const agent = makeAgent([node('Get Alerts', 'standin.alerts', { credentials: { grafanaApi: { id: cred.id, name: cred.name } } })]);
    script.calls = [{ name: 'Get_Alerts', input: {} }];
    const smoke = await smokeTest(agent.id, 'Which alerts are firing?');
    expect(smoke).toMatchObject({ state: 'passed', tools: [{ name: 'Get Alerts', status: 'success' }] });
    expect(script.turns).toBe(2);
  });

  it('does not count a credential slot the tool hides', async () => {
    const agent = makeAgent([node('Lookup', 'standin.lookup')]);
    script.calls = [{ name: 'Lookup', input: {} }];
    const r = await smokeTest(agent.id, 'Look it up');
    expect(r).toMatchObject({ state: 'passed', tools: [{ status: 'success' }] });
  });

  it('fails when a tool throws, however fluent the reply', async () => {
    const cred = credentials.create({ name: 'Grafana', type: 'standin.grafanaApi', data: { token: 'x' } });
    const agent = makeAgent([node('Get Alerts', 'standin.alerts', { credentials: { grafanaApi: { id: cred.id, name: cred.name } } })]);
    behave.alerts = 'throws';
    script.calls = [{ name: 'Get_Alerts', input: {} }];
    const smoke = await smokeTest(agent.id, 'Which alerts are firing?');
    expect(smoke.state).toBe('failed');
    expect(smoke.reason).toBe('Get Alerts failed: Grafana answered 401.');
    expect(smoke.tools).toEqual([{ name: 'Get Alerts', status: 'error', note: 'Grafana answered 401.' }]);
  });

  it('fails when every call returned nothing', async () => {
    const cred = credentials.create({ name: 'Grafana', type: 'standin.grafanaApi', data: { token: 'x' } });
    const agent = makeAgent([node('Get Alerts', 'standin.alerts', { credentials: { grafanaApi: { id: cred.id, name: cred.name } } })]);
    behave.alerts = 'empty';
    script.calls = [{ name: 'Get_Alerts', input: {} }];
    const smoke = await smokeTest(agent.id, 'Which alerts are firing?');
    expect(smoke).toMatchObject({ state: 'failed', reason: 'Get Alerts returned nothing to work with', tools: [{ name: 'Get Alerts', status: 'empty' }] });
  });

  it('passes a denied write with the reason line, and sends nothing', async () => {
    const agent = makeAgent([node('Send Email', 'standin.send', { requireApproval: true })]);
    script.calls = [{ name: 'Send_Email', input: {} }];
    script.reply = 'I could not send it without approval; it is ready to go.';
    const smoke = await smokeTest(agent.id, 'Email the summary');
    expect(smoke).toMatchObject({ state: 'passed', reason: 'Send Email needs approval: not sent', tools: [{ name: 'Send Email', status: 'denied' }] });
    expect(behave.sent).toBe(0);
  });
});
