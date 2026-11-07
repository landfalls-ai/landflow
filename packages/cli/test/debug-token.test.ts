/**
 * `landflow debug-token`: against the real host (test/host.ts, MCP server on) it mints a token bound to one execution,
 * the token works as the bearer of /api/mcp for explain_failure and nothing else, `--list` and `--revoke` work, and the
 * arguments are checked. The host side is tested in apps/web/test/debug-token.test.ts.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTtl } from '../src/commands/debug-token';
import { cliFor, startHost, web, type Host } from './host';

let host: Host;
let cli: ReturnType<typeof cliFor>;
const work = mkdtempSync(join(tmpdir(), 'landflow-cli-debug-token-'));
const SECRET_VALUE = 'hunter2-very-secret-value';

const node = (id: string, name: string, type: string, parameters: Record<string, unknown> = {}) => ({ id, name, type, typeVersion: 1, position: [0, 0], parameters });
const edge = (source: string, target: string) => ({ id: `e_${source}_${target}`, type: 'main', source, sourceIndex: 0, target, targetIndex: 0 });

let execution = '';

async function mcp(token: string, method: string, params: unknown = {}) {
  const response = await fetch(`${host.url}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const raw = await response.text();
  let body: any = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    body = JSON.parse(raw.includes('data:') ? raw.split('\n').find((l) => l.startsWith('data:'))!.slice(5) : raw);
  } catch {}
  return { status: response.status, body, raw };
}

beforeAll(async () => {
  host = await startHost();
  (await web('lib/server/mcp/instance')).setMcpEnabled(true);
  // A real user and API key: a token's minter must exist (the synthetic test owner has no user row).
  const owner = await (await web('lib/server/auth/users')).createOwner({ email: 'dbg-owner@landflow.test', name: 'Debug Owner', password: 'correct horse battery staple' });
  const key = (await web('lib/server/auth/api-keys')).createApiKey(owner, { label: 'cli', scopes: ['admin'] });
  cli = cliFor(host, { env: { LANDFLOW_API_KEY: key.token } });
  expect((await cli(['variables', 'set', 'DEBUG_SECRET', SECRET_VALUE])).code).toBe(0);
  const flow = {
    name: 'Fails for a token',
    nodes: [node('start', 'Start', 'core.manualTrigger'), node('boom', 'Boom', 'core.stopAndError', { message: `it broke with ${SECRET_VALUE}` })],
    connections: [edge('start', 'boom')],
  };
  const file = join(work, 'f.json');
  writeFileSync(file, JSON.stringify(flow));
  const created = await cli(['workflows', 'create', '--file', file, '--json']);
  const run = await cli(['run', created.json.workflow.id, '--wait', '--json']);
  execution = run.json.error.details.execution.id as string;
});
afterAll(async () => {
  await host?.close();
});

describe('debug-token', () => {
  it('parses lifetimes', () => {
    expect([parseTtl('90s'), parseTtl('30m'), parseTtl('1h'), parseTtl('2h30m'), parseTtl('120')]).toEqual([90, 1800, 3600, 9000, 120]);
    for (const bad of ['', 'soon', '10s', '25h', '1d', '-5m']) expect(() => parseTtl(bad), bad).toThrow();
  });

  it('mints a token for one execution that explains the failure, redacted, and nothing else', async () => {
    const minted = await cli(['debug-token', '--execution', execution, '--ttl', '30m', '--label', 'for claude', '--json']);
    expect(minted.code, minted.stdout).toBe(0);
    const { token, record } = minted.json;
    expect(token).toMatch(/^lf_dbg_/);
    expect(record).toMatchObject({ executionId: execution, label: 'for claude', scopes: ['executions:read', 'trace:read'], uses: 0 });
    expect(Date.parse(record.expiresAt) - Date.parse(record.createdAt)).toBe(30 * 60_000);
    expect(minted.json.mcpUrl).toBe(`${host.url}/api/mcp`);

    const tools = await mcp(token, 'tools/list');
    expect(tools.body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(['explain_failure', 'get_execution', 'get_run_trace']);
    const explained = await mcp(token, 'tools/call', { name: 'explain_failure', arguments: { id: execution } });
    expect(explained.body.result.isError).toBeFalsy();
    expect(explained.raw).toContain('Boom');
    expect(explained.raw).not.toContain(SECRET_VALUE);
    // Not a workflow tool, and not the REST API.
    const other = await mcp(token, 'tools/call', { name: 'list_workflows', arguments: {} });
    expect(other.body.error !== undefined || other.body.result?.isError === true).toBe(true);
    expect((await fetch(`${host.url}/api/workflows`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    // It also names one other execution it does not have as not found.
    expect((await mcp(token, 'tools/call', { name: 'get_execution', arguments: { id: 'ex_other' } })).body.result.isError).toBe(true);
  });

  it('lists the execution’s tokens (never the token) and revokes one', async () => {
    const minted = await cli(['debug-token', '--execution', execution, '--scopes', 'trace:read', '--json']);
    const { token, record } = minted.json;
    expect(record.scopes).toEqual(['trace:read']);
    const listed = await cli(['debug-token', '--execution', execution, '--list', '--json']);
    expect(listed.json.tokens.map((t: { id: string }) => t.id)).toContain(record.id);
    expect(listed.stdout).not.toContain(token);
    expect((await cli(['debug-token', '--execution', execution, '--list'])).stdout).toMatch(/live/);

    expect((await mcp(token, 'tools/call', { name: 'get_run_trace', arguments: { id: execution } })).body.result.isError).toBeFalsy();
    const revoked = await cli(['debug-token', '--execution', execution, '--revoke', record.id, '--json']);
    expect(revoked.json).toMatchObject({ revoked: true });
    const after = await mcp(token, 'tools/call', { name: 'get_run_trace', arguments: { id: execution } });
    expect(after.status).toBe(401);
    expect((await cli(['debug-token', '--execution', execution, '--revoke', record.id, '--json'])).json.revoked).toBe(false);
    expect((await cli(['debug-token', '--execution', execution, '--list'])).stdout).toMatch(/revoked/);
  });

  it('says what it needs, and what the host refuses', async () => {
    expect((await cli(['debug-token'])).code).toBe(2);
    expect((await cli(['debug-token', '--execution', execution, '--ttl', '10s'])).code).toBe(2);
    expect((await cli(['debug-token', '--execution', 'ex_missing'])).code).toBe(3);
    const badScope = await cli(['debug-token', '--execution', execution, '--scopes', 'executions:write', '--json']);
    expect(badScope.code).toBe(1);
    expect(badScope.json.error.status).toBe(400);
    const human = await cli(['debug-token', '--execution', execution, '--ttl', '1h']);
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(/lf_dbg_/);
    expect(human.stdout).toMatch(/--revoke/);
  });
});
