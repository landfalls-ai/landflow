/**
 * C27: a marketplace node plugin is downloaded into a staging folder and hashed before anything is asked (docs/marketplace.md#node-plugins).
 * The confirmation names the hash; a confirmed install records the approval; a reinstall of an approved hash needs no confirm; a plugin that
 * changed since says so; a confirm with a stale hash is 409 and installs nothing; the staging folder is gone after every answer.
 * A local marketplace directory; the supervisor (npm install, spawn) is stubbed, the download, hash and trust are real.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-trust-mkt-data-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_MARKETPLACE_ALLOW_LOCAL: '1', LANDFLOW_MARKETPLACE_REGISTRY_URL: 'off', LANDFLOW_AUDIT_OUTBOX: 'off', LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { marketplace, MarketplaceError } = await import('@/lib/server/marketplace/service');
const { marketplaceStore } = await import('@/lib/server/marketplace/store');
const { nodePlugins } = await import('@/lib/server/marketplace/node-plugins');
const { clearTreeCache } = await import('@/lib/server/marketplace/reader');
const { queryEvents } = await import('@/lib/server/audit/store');
const trust = await import('@/lib/server/trust/store');
const route = await import('@/app/api/marketplaces/[id]/plugins/[name]/install/route');
type Confirmation = import('@/lib/shared/marketplace').InstallConfirmation;
type Result = import('@/lib/shared/marketplace').InstallResult;

const root = mkdtempSync(join(tmpdir(), 'landflow-trust-mkt-'));
const write = (path: string, content: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};
let marketplaceId = '';
const stagingDir = () => join(marketplaceStore.dir, 'staging');
const stagingLeft = () => (existsSync(stagingDir()) ? readdirSync(stagingDir()) : []);

beforeAll(async () => {
  clearTreeCache();
  write('.claude-plugin/marketplace.json', JSON.stringify({ name: 'trust-fixture', plugins: [{ name: 'echo-nodes', source: './echo' }] }));
  write('echo/landflow.plugin.json', JSON.stringify({ id: 'echo-nodes', runtime: 'node', start: ['tsx', 'main.ts'] }));
  write('echo/main.ts', 'console.log("v1");\n');
  // No process is started and no dependencies fetched: the supervisor is the part that needs a network and a runtime.
  vi.spyOn(nodePlugins, 'prepare').mockResolvedValue(undefined as never);
  vi.spyOn(nodePlugins, 'start').mockImplementation(() => undefined as never);
  vi.spyOn(nodePlugins, 'stop').mockResolvedValue(undefined as never);
  marketplaceId = (await marketplace.add(root)).id;
});
afterAll(() => vi.restoreAllMocks());

const subject = 'trust-fixture/echo-nodes';
const install = (options?: { confirm?: boolean; hash?: string }) => marketplace.install(marketplaceId, 'echo-nodes', options);

describe('trust for marketplace node plugins', () => {
  it('asks first with the hash of the downloaded files, installs on a confirm with that hash and records the approval', async () => {
    const confirm = (await install()) as Confirmation;
    expect(confirm.needsConfirmation).toBe(true);
    expect(confirm.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(confirm.changedSince).toBeUndefined();
    expect(stagingLeft()).toEqual([]);
    expect(marketplace.installed()).toEqual([]);
    const result = (await install({ confirm: true, hash: confirm.hash })) as Result;
    expect(result.installed.nodePlugin?.contentHash).toBe(confirm.hash);
    expect(existsSync(join(result.installed.nodePlugin!.dir, 'main.ts'))).toBe(true);
    expect(trust.isApproved('marketplace-plugin', subject, confirm.hash!)).toBe(true);
    expect(stagingLeft()).toEqual([]);
    const events = queryEvents({ action: ['trust.approve'], targetId: subject }).events;
    expect(events[0].details).toMatchObject({ subject, hash: confirm.hash });
  });

  it('a reinstall of the same files needs no confirm (AS-2) and records nothing new', async () => {
    await marketplace.uninstall('echo-nodes@trust-fixture');
    const before = queryEvents({ action: ['trust.approve'], targetId: subject }).events.length;
    const result = (await install()) as Result;
    expect(result.installed.id).toBe('echo-nodes@trust-fixture');
    expect(queryEvents({ action: ['trust.approve'], targetId: subject }).events.length).toBe(before);
    expect(stagingLeft()).toEqual([]);
  });

  it('a plugin that changed since says so, and installs only after a yes (AS-1)', async () => {
    await marketplace.uninstall('echo-nodes@trust-fixture');
    write('echo/main.ts', 'console.log("v2, now it phones home");\n');
    const confirm = (await install()) as Confirmation;
    expect(confirm.needsConfirmation).toBe(true);
    expect(confirm.changedSince?.hash).toMatch(/^sha256:/);
    expect(confirm.changedSince?.hash).not.toBe(confirm.hash);
    expect(confirm.warning).toContain('changed since you approved it on');
    expect(marketplace.installed()).toEqual([]);
    await install({ confirm: true, hash: confirm.hash });
    expect(trust.currentApproval('marketplace-plugin', subject)?.hash).toBe(confirm.hash);
    expect(marketplace.installed()).toHaveLength(1);
  });

  it('a confirm with a stale hash is 409, installs nothing and leaves no staging folder', async () => {
    await marketplace.uninstall('echo-nodes@trust-fixture');
    write('echo/main.ts', 'console.log("v3");\n');
    const confirm = (await install()) as Confirmation;
    write('echo/main.ts', 'console.log("v3 but swapped after you looked");\n');
    const caught = await install({ confirm: true, hash: confirm.hash }).then(() => undefined, (error: unknown) => error);
    expect(caught).toBeInstanceOf(MarketplaceError);
    expect((caught as InstanceType<typeof MarketplaceError>).status).toBe(409);
    expect((caught as InstanceType<typeof MarketplaceError>).body?.hash).not.toBe(confirm.hash);
    expect(marketplace.installed()).toEqual([]);
    expect(stagingLeft()).toEqual([]);
    expect(trust.isApproved('marketplace-plugin', subject, confirm.hash!)).toBe(false);
  });

  it('the install route passes the hash through and answers 409 with it for a first install', async () => {
    const ctx = { params: Promise.resolve({ id: marketplaceId, name: 'echo-nodes' }) };
    const request = (body: unknown) => new Request(`http://x/api/marketplaces/${marketplaceId}/plugins/echo-nodes/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const first = await route.POST(request({}), ctx);
    expect(first.status).toBe(409);
    const asked = (await first.json()) as Confirmation;
    expect(asked.hash).toMatch(/^sha256:/);
    const stale = await route.POST(request({ confirm: true, hash: 'sha256:' + '0'.repeat(64) }), ctx);
    expect(stale.status).toBe(409);
    expect(marketplace.installed()).toEqual([]);
    const done = await route.POST(request({ confirm: true, hash: asked.hash }), ctx);
    expect(done.status).toBe(201);
    const audit = queryEvents({ action: ['marketplace.install'] }).events[0];
    expect(audit.details).toMatchObject({ hash: asked.hash });
  });
});
