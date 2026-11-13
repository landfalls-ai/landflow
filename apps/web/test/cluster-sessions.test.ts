/**
 * Queue mode without sticky sessions: what a browser started on one main finishes on any main.
 *
 * - Debug sessions (lib/server/cluster/debug.ts): a debugger command for a run held by another main goes out on the
 *   control channel and comes back with that main's answer (the route answers as if the session were local); an error
 *   other than "not running here" passes through; nobody holding it ends as "not running" after the timeout. Where a
 *   session held elsewhere is paused follows the relayed events, so the run shows its pause on every main.
 * - OIDC (lib/server/auth/oidc.ts): the pending sign-in lives in Valkey (sealed, keyed by the state's hash) rather than
 *   in one main's memory, is taken at most once, and needs the browser's state cookie.
 *
 * One process plays this main (startCluster on an in-process coordinator); a Relay on the same hub plays the other.
 */
import { mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ExecutionRecord } from '@/lib/shared/types';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-cluster-sessions-'));
const ENV: Record<string, string | undefined> = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_DB: 'sqlite',
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_EXECUTIONS_MODE: 'queue',
  LANDFLOW_QUEUE_ALLOW_SQLITE: 'true',
  LANDFLOW_INSTANCE_ID: 'main-here',
  LANDFLOW_WORKER_PORT: '0',
  LANDFLOW_ENCRYPTION_KEY: 'cluster-sessions-test-key',
  LANDFLOW_ROLE: undefined,
};
const previousEnv = { ...process.env };
for (const [key, value] of Object.entries(ENV)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const { startCluster, stopCluster } = await import('@/lib/server/cluster');
const { MemoryCoordinator, MemoryHub } = await import('@/lib/server/cluster/memory');
const { Relay } = await import('@/lib/server/cluster/relay');
const { answerDebugRequest, debugAnywhere, debugElsewhere, notePausedEvent, pausedElsewhere } = await import('@/lib/server/cluster/debug');
type DebugControl = import('@/lib/server/cluster/debug').DebugControl;
const { debugExecution, liveExecution } = await import('@/lib/server/runner');
const { store } = await import('@/lib/server/store');
const debugRoute = await import('@/app/api/executions/[id]/debug/route');
const { beginLogin, completeLogin, resetOidcCaches } = await import('@/lib/server/auth/oidc');
type OidcConfig = import('@/lib/server/auth/oidc').OidcConfig;

const hub = new MemoryHub();
/** The other main: it holds the run `ex_remote` (paused) and `ex_running` (running, not paused). */
const other = new Relay(new MemoryCoordinator(hub), 'main-there');
const asked: DebugControl[] = [];
const held = new Map<string, { paused: boolean }>([
  ['ex_remote', { paused: true }],
  ['ex_running', { paused: false }],
]);

beforeAll(async () => {
  expect(await startCluster({ coordinator: new MemoryCoordinator(hub) })).toBe(true);
  await other.listen<DebugControl>('control', (message) => {
    if (message.t !== 'debug') return;
    asked.push(message);
    // What the other main's runner would answer (debugExecution), sent back through answerDebugRequest.
    answerDebugRequest(message, (id, request) => {
      const run = held.get(id);
      if (!run) return { ok: false, error: 'Execution is not running', status: 404 };
      if (request.command && request.command !== 'stop' && !run.paused) return { ok: false, error: 'Execution is not paused', status: 409 };
      return { ok: true, ...(!request.command && run.paused && { paused: { nodeId: 'n1', nodeName: 'Set', reason: 'breakpoint' as const, since: '2026-10-26T00:00:00.000Z' } }) };
    });
  });
});

afterAll(async () => {
  await stopCluster();
  await other.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe('debug sessions held by another main', () => {
  it('sends a command to the main holding the session and answers with its result', async () => {
    expect(debugExecution('ex_remote', { command: 'continue' })).toMatchObject({ status: 404 });
    expect(await debugAnywhere('ex_remote', { command: 'continue', breakpoints: ['n2'] }, debugExecution)).toEqual({ ok: true });
    expect(asked.at(-1)).toMatchObject({ t: 'debug', id: 'ex_remote', from: 'main-here', command: 'continue', breakpoints: ['n2'] });
    // No command: where it is paused.
    expect(await debugAnywhere('ex_remote', {}, debugExecution)).toMatchObject({ ok: true, paused: { nodeName: 'Set', reason: 'breakpoint' } });
    // The other main's error passes through.
    expect(await debugAnywhere('ex_running', { command: 'step' }, debugExecution)).toEqual({ ok: false, error: 'Execution is not paused', status: 409 });
  });

  it('answers through the route as if the session were local, and 404 when nobody holds it', async () => {
    const post = (id: string, body: object) =>
      debugRoute.POST(new Request(`http://localhost/api/executions/${id}/debug`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify(body) }), {
        params: Promise.resolve({ id }),
      });
    const answered = await post('ex_remote', { command: 'step' });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ ok: true });
    // Nobody holds it: no answer within the timeout, so "not running".
    expect(await debugElsewhere('ex_nobody', { command: 'continue' }, 200)).toBeUndefined();
    const missing = await post('ex_nobody', { command: 'continue' });
    expect(missing.status).toBe(404);
  });

  it('shows where a session held elsewhere is paused, from the relayed events', async () => {
    const at = new Date().toISOString();
    const record: ExecutionRecord = { executionId: 'ex_paused_far', workflowId: 'wf_far', workflowName: 'Far', mode: 'manual', status: 'running', startedAt: at, finishedAt: '', durationMs: 0, runData: {}, executionOrder: [] };
    store.saveExecution(record);
    await other.broadcast('bus', { channel: 'execution', workflowId: 'wf_far', event: { type: 'execution.paused', executionId: 'ex_paused_far', nodeId: 'n1', nodeName: 'Set', reason: 'step', inputs: [], at } });
    await vi.waitFor(() => expect(pausedElsewhere('ex_paused_far')).toMatchObject({ nodeName: 'Set', reason: 'step', since: at }));
    expect(liveExecution('ex_paused_far')).toMatchObject({ status: 'running', paused: { nodeId: 'n1', nodeName: 'Set', reason: 'step' } });
    notePausedEvent({ type: 'execution.resumed', executionId: 'ex_paused_far', command: 'continue', at });
    expect(pausedElsewhere('ex_paused_far')).toBeUndefined();
    expect(liveExecution('ex_paused_far')?.paused).toBeUndefined();
  });
});

describe('OIDC sign-in across mains', () => {
  let provider: Server;
  let issuer = '';
  const tokenCalls: string[] = [];

  beforeAll(async () => {
    provider = createServer((req, res) => {
      const send = (status: number, body: object) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/.well-known/openid-configuration') return send(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
      if (req.url === '/token') {
        tokenCalls.push(req.url);
        return send(400, { error: 'invalid_grant', error_description: 'test provider' });
      }
      send(404, {});
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    issuer = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    resetOidcCaches();
  });
  afterAll(() => provider.close());

  const config = (): OidcConfig => ({ issuer, clientId: 'landflow', scopes: 'openid email', label: 'Test', roleClaim: 'roles', roleMap: {}, defaultRole: 'member' });

  it('keeps the pending sign-in in Valkey, sealed, for any main to take once', async () => {
    const { url, state } = await beginLogin(config(), 'http://localhost:3000', '/workflows');
    const authorize = new URL(url);
    expect(authorize.searchParams.get('state')).toBe(state);
    const key = `oidc:state:${createHash('sha256').update(state).digest('hex')}`;
    const sealed = hub.key(key);
    expect(sealed).toMatch(/^v[12]\./);
    // Sealed: neither the PKCE verifier's challenge input nor where to go next is readable.
    expect(sealed).not.toContain('/workflows');
    expect(sealed).not.toContain(authorize.searchParams.get('nonce')!);

    // Another browser (no or another state cookie) can't use it, and doesn't use it up.
    await expect(completeLogin(config(), { code: 'abc', state, cookieState: 'other' })).rejects.toThrow(/expired or was started in another browser/);
    expect(hub.key(key)).toBe(sealed);

    // The right browser on any main takes it (the provider then refuses the code here), once.
    await expect(completeLogin(config(), { code: 'abc', state, cookieState: state })).rejects.not.toThrow(/expired or was started in another browser/);
    expect(hub.key(key)).toBeUndefined();
    await expect(completeLogin(config(), { code: 'abc', state, cookieState: state })).rejects.toThrow(/expired or was started in another browser/);
  });
});
