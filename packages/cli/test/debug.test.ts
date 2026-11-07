/**
 * `debug-bundle`, `replay`, `claude init` and `executions watch`: against the real host (test/host.ts, its MCP
 * server turned on) for the shapes and the redaction, and against a fake fetch for the unhappy paths.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeRedactor } from '../src/redact';
import { cliFor, startHost, web, type Host } from './host';

let host: Host;
let cli: ReturnType<typeof cliFor>;
const work = mkdtempSync(join(tmpdir(), 'landflow-cli-debug-'));
const SECRET_VALUE = 'hunter2-very-secret-value';

const node = (id: string, name: string, type: string, parameters: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ id, name, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
const edge = (source: string, target: string) => ({ id: `e_${source}_${target}`, type: 'main', source, sourceIndex: 0, target, targetIndex: 0 });

const failing = {
  name: 'Fails after set',
  nodes: [
    node('start', 'Start', 'core.manualTrigger'),
    node('set', 'Set', 'core.set', { mode: 'json', json: '{"greeting": "hello", "apiKey": "abc-123-def"}' }),
    node('boom', 'Boom', 'core.stopAndError', { message: `it broke with ${SECRET_VALUE}` }),
  ],
  connections: [edge('start', 'set'), edge('set', 'boom')],
};

beforeAll(async () => {
  host = await startHost();
  // The test host has no API keys, so the MCP endpoint gets the instance access token (Settings → MCP) in their place.
  const { token } = (await web('lib/server/mcp/instance')).setMcpEnabled(true) as { token: string };
  const real = globalThis.fetch;
  const withToken: typeof fetch = (input, init) => (String(input).endsWith('/api/mcp') ? real(input, { ...init, headers: { ...(init?.headers as Record<string, string>), authorization: `Bearer ${token}` } }) : real(input, init));
  cli = cliFor(host, { fetch: withToken });
  expect((await cli(['variables', 'set', 'DEBUG_SECRET', SECRET_VALUE])).code).toBe(0);
});
afterAll(async () => {
  await host?.close();
});

async function failedExecution(): Promise<string> {
  const created = await cli(['workflows', 'create', '--file', (writeFileSync(join(work, 'f.json'), JSON.stringify(failing)), join(work, 'f.json')), '--json']);
  const id = created.json.workflow.id as string;
  const run = await cli(['run', id, '--wait', '--json']);
  expect(run.code).toBe(1);
  return run.json.error.details.execution.id as string;
}

describe('debug-bundle', () => {
  it('writes a redacted folder', async () => {
    const execution = await failedExecution();
    const out = join(work, 'bundle');
    const result = await cli(['debug-bundle', execution, '--out', out, '--json']);
    expect(result.code, result.stdout).toBe(0);
    expect(result.json.skipped, JSON.stringify(result.json.skipped)).toEqual([]);
    expect(result.json.status).toBe('error');
    for (const name of ['bundle.json', 'README.md', 'workflow.json', 'execution.json', 'run-data.json', 'explanation.json', 'trace.json', 'node-types.json']) {
      expect(existsSync(join(out, name)), name).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(join(out, 'bundle.json'), 'utf8'));
    expect(manifest.failedNode).toEqual({ id: 'boom', name: 'Boom' });
    expect(manifest.format).toBe('landflow-debug-bundle/v1');
    expect(JSON.parse(readFileSync(join(out, 'explanation.json'), 'utf8')).failingNode ?? JSON.parse(readFileSync(join(out, 'explanation.json'), 'utf8'))).toBeTruthy();
    // The $vars value and the secret-named key are gone from every file.
    const all = readdirSync(out, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.json') || f.endsWith('.md'))
      .map((f) => readFileSync(join(out, f), 'utf8'))
      .join('\n');
    expect(all).not.toContain(SECRET_VALUE);
    expect(all).not.toContain('abc-123-def');
    expect(all).toContain('[redacted]');
    expect(result.json.redaction.values + result.json.redaction.keys).toBeGreaterThan(0);
  });

  it('refuses a folder that has files, unless --force', async () => {
    const execution = await failedExecution();
    const out = join(work, 'bundle-2');
    expect((await cli(['debug-bundle', execution, '--out', out])).code).toBe(0);
    const again = await cli(['debug-bundle', execution, '--out', out, '--json']);
    expect(again.code).toBe(5);
    expect((await cli(['debug-bundle', execution, '--out', out, '--force'])).code).toBe(0);
  });

  it('is not found for an unknown execution (exit 3)', async () => {
    expect((await cli(['debug-bundle', 'nope', '--out', join(work, 'nope'), '--json'])).code).toBe(3);
  });

  it('lists what it could not read instead of failing', async () => {
    const execution = await failedExecution();
    const real = globalThis.fetch;
    const noMcp: typeof fetch = async (input, init) => (String(input).endsWith('/api/mcp') ? new Response('{}', { status: 403 }) : real(input, init));
    const out = join(work, 'bundle-3');
    const result = await cli(['debug-bundle', execution, '--out', out, '--json'], { fetch: noMcp });
    expect(result.code, result.stdout).toBe(0);
    expect(result.json.skipped.map((s: { what: string }) => s.what)).toContain('explain_failure');
    expect(existsSync(join(out, 'run-data.json'))).toBe(true);
    expect(existsSync(join(out, 'explanation.json'))).toBe(false);
  });
});

describe('replay', () => {
  it('prints the steps without --target, and refuses the source host without --same-host', async () => {
    const execution = await failedExecution();
    const out = join(work, 'bundle-r');
    await cli(['debug-bundle', execution, '--out', out]);
    const steps = await cli(['replay', out, '--json']);
    expect(steps.code).toBe(0);
    expect(steps.json).toMatchObject({ ran: false, pinned: ['Start', 'Set'] });
    expect(steps.json.steps.length).toBeGreaterThan(3);
    const same = await cli(['replay', out, '--target', host.url, '--json']);
    expect(same.json.ran).toBe(false);
    expect(same.json.reason).toContain('--same-host');
  });

  it('runs the workflow with the upstream data pinned and deletes the copy', async () => {
    const execution = await failedExecution();
    const out = join(work, 'bundle-r2');
    await cli(['debug-bundle', execution, '--out', out]);
    const before = (await cli(['workflows', 'list', '--json'])).json.workflows.length;
    const result = await cli(['replay', out, '--target', host.url, '--same-host', '--json']);
    expect(result.code, result.stdout).toBe(0);
    expect(result.json).toMatchObject({ ran: true, reproduced: true, pinned: ['Start', 'Set'] });
    expect(result.json.execution.status).toBe('error');
    expect((await cli(['workflows', 'list', '--json'])).json.workflows.length).toBe(before);
  });

  it('rejects a folder that is not a bundle (exit 1)', async () => {
    const result = await cli(['replay', work, '--json']);
    expect(result.code).toBe(1);
    expect(result.json.error.code).toBe('io');
  });
});

describe('executions watch', () => {
  it('prints node progress and exits 1 for a failed run', async () => {
    const execution = await failedExecution();
    const result = await cli(['executions', 'watch', execution]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Set: success');
    expect(result.stdout).toContain('Boom: error');
    const json = await cli(['executions', 'watch', execution, '--json']);
    expect(json.json.error.code).toBe('execution_failed');
    expect(json.json.error.details.events.length).toBeGreaterThan(0);
  });

  it('follows a run until it ends (fake poll)', async () => {
    const states = ['running', 'running', 'success'];
    let call = 0;
    const fake: typeof fetch = async () => {
      const status = states[Math.min(call++, states.length - 1)];
      const runData = { a: [{ status: status === 'running' ? 'running' : 'success', outputs: [[{ json: {} }]] }] };
      return Response.json({ execution: { id: 'x', workflowId: 'w', workflowName: 'W', status, mode: 'manual', startedAt: '', durationMs: 5, runData, nodeNames: { a: 'A' }, executionOrder: ['a'] } });
    };
    const result = await cli(['executions', 'watch', 'x', '--json'], { fetch: fake });
    expect(result.code).toBe(0);
    expect(result.json.execution.status).toBe('success');
    expect(result.json.events.map((e: { type: string }) => e.type)).toContain('node');
  });

  it('times out (exit 7)', async () => {
    const fake: typeof fetch = async () => Response.json({ execution: { id: 'x', status: 'running', runData: {} } });
    expect((await cli(['executions', 'watch', 'x', '--timeout', '0.05', '--interval', '50', '--json'], { fetch: fake })).code).toBe(7);
  });
});

describe('claude init', () => {
  it('writes .mcp.json (no key) and the skill, and leaves existing files alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'landflow-cli-init-'));
    const first = await cli(['claude', 'init', '--dir', dir, '--json'], { env: { LANDFLOW_API_KEY: 'lf_supersecretkey123456' } });
    expect(first.code, first.stdout).toBe(0);
    expect(first.json.written).toEqual(['.mcp.json', '.claude/skills/landflow/SKILL.md']);
    const mcp = readFileSync(join(dir, '.mcp.json'), 'utf8');
    expect(JSON.parse(mcp).mcpServers.landflow).toMatchObject({ type: 'http', url: `${host.url}/api/mcp` });
    expect(mcp).not.toContain('supersecretkey');
    expect(mcp).toContain('${LANDFLOW_API_KEY}');
    const skill = readFileSync(join(dir, '.claude/skills/landflow/SKILL.md'), 'utf8');
    expect(skill).toContain('core.manualTrigger');
    expect(skill).toContain('explain_failure');
    writeFileSync(join(dir, '.mcp.json'), '{"mine":true}');
    const second = await cli(['claude', 'init', '--dir', dir, '--offline', '--json']);
    expect(second.json).toMatchObject({ written: [], skipped: ['.mcp.json', '.claude/skills/landflow/SKILL.md'] });
    expect(readFileSync(join(dir, '.mcp.json'), 'utf8')).toBe('{"mine":true}');
    const forced = await cli(['claude', 'init', '--dir', dir, '--offline', '--force', '--json']);
    expect(forced.json.written.length).toBe(2);
  });
});

describe('redaction', () => {
  it('keeps names and types of credentials, removes secret keys and known values', () => {
    const { redact } = makeRedactor([SECRET_VALUE, 'ab']);
    const out = redact({
      nodes: [{ credentials: { 'x.api': { id: 'cred_1', name: 'Prod', type: 'x.api', data: { k: 'v' } } }, parameters: { password: 'p', maxTokens: 100, url: `https://h/${SECRET_VALUE}?a=ab`, header: 'Bearer abcdefghijklmnop' } }],
    });
    expect(JSON.stringify(out)).not.toContain(SECRET_VALUE);
    expect(out.nodes[0].credentials).toEqual({ 'x.api': { name: 'Prod', type: 'x.api' } });
    expect(out.nodes[0].parameters).toMatchObject({ password: '[redacted]', maxTokens: 100, header: 'Bearer [redacted]' });
    expect(out.nodes[0].parameters.url).toContain('a=ab');
    expect(redact({ json: '{"apiKey": "abc-123", "name": "x"}' }).json).toBe('{"apiKey": "[redacted]", "name": "x"}');
  });
});
