/**
 * safeFetch (lib/server/net/safe-fetch.ts) and the address rules behind it (net/addresses.ts): loopback, private,
 * link-local, CGNAT and metadata addresses are refused when blocking is on (default in the production profile),
 * for literal IPs, for names that resolve to them and at every redirect hop; LANDFLOW_OUTBOUND_ALLOW lists exceptions;
 * development stays open. The HTTP Request node shows the clear message.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-safe-fetch-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { classifyAddress, addressInRange } = await import('@/lib/server/net/addresses');
const { safeFetch, OutboundBlockedError } = await import('@/lib/server/net/safe-fetch');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');

registry.registerBuiltin(corePlugin);

const SETTINGS = ['LANDFLOW_PROFILE', 'LANDFLOW_OUTBOUND_BLOCK_PRIVATE', 'LANDFLOW_OUTBOUND_ALLOW', 'OLLAMA_URL', 'LANDFLOW_CODE_RUNNER_URL'];
const saved = Object.fromEntries(SETTINGS.map((name) => [name, process.env[name]]));
const clearSettings = () => SETTINGS.forEach((name) => delete process.env[name]);

let target: Server;
let other: Server;
let port = 0;
let otherPort = 0;
let redirectTo = '';
const seen: string[] = [];

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, resolve)); // dual-stack: 127.0.0.1, ::1 and localhost all reach it
  return (server.address() as { port: number }).port;
};

beforeAll(async () => {
  other = createServer((_req, res) => res.end('other'));
  target = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url?.startsWith('/redirect')) {
      res.statusCode = 302;
      res.setHeader('location', redirectTo);
      return res.end();
    }
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  port = await listen(target);
  otherPort = await listen(other);
});

afterAll(async () => {
  await Promise.all([target, other].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  clearSettings();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

afterEach(() => {
  clearSettings();
  seen.length = 0;
});

const blockOn = () => {
  process.env.LANDFLOW_OUTBOUND_BLOCK_PRIVATE = 'true';
};
const refused = (promise: Promise<unknown>, host: string) =>
  promise.then(
    () => expect.unreachable('the request went out'),
    (error) => {
      expect(error).toBeInstanceOf(OutboundBlockedError);
      expect((error as Error).message).toBe(`Blocked: ${host} resolves to a private address (LANDFLOW_OUTBOUND_ALLOW lists exceptions)`);
    },
  );

describe('address classes', () => {
  it('names each kind, with IPv4-mapped IPv6 judged by the IPv4 inside', () => {
    const kinds: Record<string, string> = {
      '127.0.0.1': 'loopback',
      '::1': 'loopback',
      '::ffff:127.0.0.1': 'loopback',
      '::ffff:7f00:1': 'loopback',
      '10.1.2.3': 'private',
      '172.16.0.1': 'private',
      '172.32.0.1': 'public',
      '192.168.1.1': 'private',
      'fd12::1': 'private',
      '169.254.1.1': 'link-local',
      'fe80::1': 'link-local',
      '100.64.0.1': 'cgnat',
      '0.0.0.0': 'unspecified',
      '::': 'unspecified',
      '224.0.0.1': 'multicast',
      'ff02::1': 'multicast',
      '255.255.255.255': 'broadcast',
      '169.254.169.254': 'metadata',
      '::ffff:169.254.169.254': 'metadata',
      'fd00:ec2::254': 'metadata',
      '8.8.8.8': 'public',
      '2606:4700:4700::1111': 'public',
    };
    for (const [ip, kind] of Object.entries(kinds)) expect(classifyAddress(ip), ip).toBe(kind);
  });

  it('matches CIDR ranges and single addresses', () => {
    expect(addressInRange('10.4.5.6', '10.0.0.0/8')).toBe(true);
    expect(addressInRange('11.4.5.6', '10.0.0.0/8')).toBe(false);
    expect(addressInRange('127.0.0.1', '127.0.0.1')).toBe(true);
    expect(addressInRange('::ffff:10.0.0.9', '10.0.0.0/8')).toBe(true);
    expect(addressInRange('fd00::5', 'fd00::/8')).toBe(true);
    expect(addressInRange('fe80::5', 'fd00::/8')).toBe(false);
  });
});

describe('safeFetch', () => {
  it('blocks literal loopback, mapped loopback and metadata addresses when blocking is on', async () => {
    blockOn();
    await refused(safeFetch(`http://127.0.0.1:${port}/`), '127.0.0.1');
    await refused(safeFetch(`http://[::1]:${port}/`), '::1');
    await refused(safeFetch(`http://[::ffff:127.0.0.1]:${port}/`), '::ffff:7f00:1');
    await refused(safeFetch('http://169.254.169.254/latest/meta-data/'), '169.254.169.254');
    await refused(safeFetch('http://10.0.0.5:9/'), '10.0.0.5');
    expect(seen).toEqual([]);
  });

  it('blocks a name that resolves to loopback, at connect time', async () => {
    blockOn();
    await refused(safeFetch(`http://localhost:${port}/`), 'localhost');
    expect(seen).toEqual([]);
  });

  it('refuses anything but http and https', async () => {
    await expect(safeFetch('file:///etc/passwd')).rejects.toBeInstanceOf(OutboundBlockedError);
  });

  it('follows the production profile default, and development stays open', async () => {
    process.env.LANDFLOW_PROFILE = 'production';
    await refused(safeFetch(`http://127.0.0.1:${port}/`), '127.0.0.1');
    process.env.LANDFLOW_PROFILE = 'development';
    expect((await safeFetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    clearSettings();
    expect(await (await safeFetch(`http://127.0.0.1:${port}/`)).json()).toEqual({ ok: true });
    process.env.LANDFLOW_PROFILE = 'production';
    process.env.LANDFLOW_OUTBOUND_BLOCK_PRIVATE = 'false'; // an explicit setting wins over the profile
    expect((await safeFetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
  });

  it('allows listed addresses, CIDR ranges and host names', async () => {
    blockOn();
    process.env.LANDFLOW_OUTBOUND_ALLOW = '127.0.0.1';
    expect((await safeFetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    process.env.LANDFLOW_OUTBOUND_ALLOW = '10.0.0.0/8, 127.0.0.0/8';
    expect((await safeFetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    process.env.LANDFLOW_OUTBOUND_ALLOW = '10.0.0.0/8';
    await refused(safeFetch(`http://127.0.0.1:${port}/`), '127.0.0.1');
    process.env.LANDFLOW_OUTBOUND_ALLOW = 'localhost';
    expect((await safeFetch(`http://localhost:${port}/`)).status).toBe(200);
    process.env.LANDFLOW_OUTBOUND_ALLOW = '*.localhost';
    await refused(safeFetch(`http://localhost:${port}/`), 'localhost');
    expect((await safeFetch(`http://app.localhost:${port}/`)).status).toBe(200);
  });

  it('lets the hosts of OLLAMA_URL and LANDFLOW_CODE_RUNNER_URL through without listing them', async () => {
    blockOn();
    process.env.OLLAMA_URL = `http://127.0.0.1:${port}`;
    expect((await safeFetch(`http://127.0.0.1:${port}/api/tags`)).status).toBe(200);
    delete process.env.OLLAMA_URL;
    await refused(safeFetch(`http://127.0.0.1:${port}/`), '127.0.0.1');
    process.env.LANDFLOW_CODE_RUNNER_URL = `http://127.0.0.1:${port}`;
    expect((await safeFetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
  });

  it('checks every redirect hop: an allowed host cannot send the request on to a blocked one', async () => {
    blockOn();
    process.env.LANDFLOW_OUTBOUND_ALLOW = 'localhost'; // by name only: the literal addresses stay blocked
    redirectTo = `http://127.0.0.1:${otherPort}/`;
    await refused(safeFetch(`http://localhost:${port}/redirect`), '127.0.0.1');
    redirectTo = 'http://169.254.169.254/latest/meta-data/';
    await refused(safeFetch(`http://localhost:${port}/redirect`), '169.254.169.254');
    redirectTo = `http://localhost:${port}/final`;
    const response = await safeFetch(`http://localhost:${port}/redirect`);
    expect(response.status).toBe(200);
    expect(seen).toEqual(['GET /redirect', 'GET /redirect', 'GET /redirect', 'GET /final']);
  });

  it('applies the governance host list to every hop, and stops redirect loops', async () => {
    const hostCheck = (url: URL) => (url.hostname === 'localhost' ? `HTTP requests to ${url.hostname} are blocked on this instance` : undefined);
    redirectTo = `http://localhost:${otherPort}/`;
    await expect(safeFetch(`http://127.0.0.1:${port}/redirect`, {}, { hostCheck })).rejects.toThrow('HTTP requests to localhost are blocked on this instance');
    redirectTo = `http://127.0.0.1:${port}/redirect`;
    await expect(safeFetch(`http://127.0.0.1:${port}/redirect`, {}, { maxRedirects: 3 })).rejects.toThrow(/Too many redirects/);
  });

  it('honours redirect: manual and drops credentials on a cross-origin hop', async () => {
    redirectTo = `http://127.0.0.1:${otherPort}/`;
    const manual = await safeFetch(`http://127.0.0.1:${port}/redirect`, { redirect: 'manual' });
    expect(manual.status).toBe(302);
    expect(manual.headers.get('location')).toBe(redirectTo);
    expect(await (await safeFetch(`http://127.0.0.1:${port}/redirect`, { headers: { authorization: 'Bearer x' } })).text()).toBe('other');
  });
});

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, x = 0): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [x, 0], parameters });
const flow = (url: string): Workflow => ({
  id: `wf_outbound_${Math.random().toString(36).slice(2, 8)}`,
  name: 'Outbound',
  nodes: [node('Start', 'core.manualTrigger'), node('Fetch', 'core.httpRequest', { method: 'GET', url }, 200)],
  connections: [{ id: 'a-b', type: 'main', source: 'Start', target: 'Fetch', sourceIndex: 0, targetIndex: 0 }],
});
const fetchError = (record: { runData?: Record<string, Array<{ error?: { message: string } }>> }) => record.runData?.Fetch?.[0]?.error;

describe('HTTP Request node', () => {
  it('fails with the clear message in the production profile and succeeds when allow-listed', async () => {
    process.env.LANDFLOW_PROFILE = 'production';
    const workflow = store.saveWorkflow(flow(`http://127.0.0.1:${port}/data`));
    const blocked = await runWorkflow({ workflow, mode: 'manual' });
    expect(blocked.status).toBe('error');
    expect(fetchError(blocked as never)?.message).toBe('Blocked: 127.0.0.1 resolves to a private address (LANDFLOW_OUTBOUND_ALLOW lists exceptions)');
    process.env.LANDFLOW_OUTBOUND_ALLOW = '127.0.0.1';
    expect((await runWorkflow({ workflow, mode: 'manual' })).status).toBe('success');
  });

  it('is unchanged in development', async () => {
    const workflow = store.saveWorkflow(flow(`http://127.0.0.1:${port}/data`));
    expect((await runWorkflow({ workflow, mode: 'manual' })).status).toBe('success');
  });
});
