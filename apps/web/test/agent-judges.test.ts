/**
 * A rule's judge (server/agents/judges.ts): the provider named by the rule builds the judge from its credential,
 * and the agent's chat model is never loaded for the model checks. A provider can be registered without touching
 * the guardrail code.
 */
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-judges-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { credentials } = await import('@/lib/server/credentials/vault');
const { applyGuardrail } = await import('@/lib/server/agents/guardrails');
const { registerJudgeProvider } = await import('@/lib/server/agents/judges');
import type { AgentGuardrail } from '@/lib/shared/agents';

registry.registerBuiltin(corePlugin);

// A fake Jev: the probability of yes is high when the text mentions the weather.
const asked: Array<{ auth: string | undefined; body: { state: string } }> = [];
const server = createServer((request, response) => {
  let raw = '';
  request.on('data', (chunk) => (raw += chunk));
  request.on('end', () => {
    const body = JSON.parse(raw) as { state: string; questions: Record<string, unknown> };
    asked.push({ auth: request.headers.authorization, body });
    const noul = /weather/i.test(body.state) ? 0.96 : 0.03;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(body.questions).map((name) => [name, { type: 'noul', noul }])), usage: { input_tokens: 50, output_tokens: 4 } }));
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const jev = credentials.create({ name: 'Fake Jev', type: 'core.typesafeApi', data: { apiKey: 'jev-secret', baseUrl: url } });

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const rule = (judge: AgentGuardrail['judge']): AgentGuardrail => ({ enabled: true, action: 'block', reply: 'Not here.', checks: { topical: { prompt: 'Parcel delivery', threshold: 0.7 } }, ...(judge && { judge }) });
const noModel = vi.fn(async () => {
  throw new Error('the agent’s model must not be loaded');
});

describe('a rule with a judge', () => {
  it('lets Jev answer the model checks, with the stored key, and never loads the agent’s model', async () => {
    const off = await applyGuardrail(rule({ provider: 'typesafe', credential: { id: jev.id, name: 'Fake Jev' } }), 'input', 'what is the weather like', { model: noModel });
    expect(off).toMatchObject({ action: 'blocked', text: 'Not here.' });
    expect(off.violations[0]).toMatchObject({ check: 'topicalAlignment', confidence: 0.96 });
    const on = await applyGuardrail(rule({ provider: 'typesafe', credential: { id: jev.id, name: 'Fake Jev' } }), 'input', 'where is my parcel', { model: noModel });
    expect(on.action).toBe('pass');
    expect(asked[0]?.auth).toBe('Bearer jev-secret');
    expect(noModel).not.toHaveBeenCalled();
  });

  it('lets a Strands Decider server answer, with no key sent', async () => {
    const strands = credentials.create({ name: 'Local Strands', type: 'core.strandsDeciderApi', data: { baseUrl: url } });
    const before = asked.length;
    const result = await applyGuardrail(rule({ provider: 'strands', credential: { id: strands.id, name: 'Local Strands' } }), 'input', 'tell me about the weather', { model: noModel });
    expect(result).toMatchObject({ action: 'blocked' });
    expect(asked[before]?.auth).toBeUndefined();
    expect(noModel).not.toHaveBeenCalled();
  });

  it('fails closed on an unknown provider or a missing credential', async () => {
    const unknown = await applyGuardrail(rule({ provider: 'nope', credential: { id: jev.id, name: 'x' } }), 'input', 'hello', {});
    expect(unknown).toMatchObject({ action: 'blocked' });
    expect(unknown.violations[0]?.reason).toMatch(/Unknown judge "nope"/);
    const bare = await applyGuardrail(rule({ provider: 'typesafe' }), 'input', 'hello', {});
    expect(bare.violations[0]?.reason).toMatch(/Choose a credential/);
  });

  it('takes a provider registered later, with no change to the guardrail code', async () => {
    registerJudgeProvider('always-flags', { credentialType: 'core.typesafeApi', build: () => async () => ({ flagged: true, confidence: 0.99, reason: 'always' }) });
    const result = await applyGuardrail(rule({ provider: 'always-flags', credential: { id: jev.id, name: 'Fake Jev' } }), 'output', 'anything', {});
    expect(result.violations[0]).toMatchObject({ confidence: 0.99, reason: 'always' });
  });
});
