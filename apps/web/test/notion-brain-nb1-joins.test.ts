/**
 * Wave nb1's joins (backbone/contracts/nb/README.md §5): NB01's brain store and change feed, NB02's Notion client and NB03's
 * links, each on its real side. The store is the real `lib/server/brain/store` (the local store registers itself), the
 * resolver the real `lib/server/brain/notion/links.ts`, the client NB02's real `notion/client.ts` registered by
 * `lib/server/runtime.ts` (no stub factory is ever set here), and the only Notion is the local fake on 127.0.0.1 with its
 * made-up token: no test here reaches api.notion.com.
 *
 * Each join fails when its seam is cut: no resolver registered (links.ts) and a linked project reads `local`; no client
 * registered (runtime.ts's NB02 line) and the check answers 500; no `emitBrainChange` in the fact writer and the listener
 * hears nothing; a copy that drifts from the contracts folder fails the last block.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineCredentialType, definePlugin } from '@landflow/sdk';
import type { BrainChange } from '@/lib/shared/brain-store';
import { FAKE_NOTION_TOKEN, FAKE_NOTION_VERSION, startFakeNotion, type FakeNotion } from './fake-notion';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-nb1-joins-'));
const ENV = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_AUDIT_OUTBOX: 'off',
  LANDFLOW_BRAIN_MODEL: 'off',
  LANDFLOW_BRAIN_EMBEDDINGS: 'off',
  LANDFLOW_PUBLIC_URL: 'http://nb1-joins.test',
};
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

// The real sides: the store (registers the local store), the links (register the resolver), the runtime (loads NB02's client).
const store = await import('@/lib/server/brain/store');
const links = await import('@/lib/server/brain/notion/links');
await import('@/lib/server/runtime');
const { NOTION_VERSION, notionClientFor } = await import('@/lib/server/notion/port');
const { registry } = await import('@/lib/server/plugins/registry');
const { credentials } = await import('@/lib/server/credentials/vault');
const projects = await import('@/lib/server/projects');
const { replaceShares } = await import('@/lib/server/projects/store');
const { database } = await import('@/lib/server/db');
const { queryEvents } = await import('@/lib/server/audit/store');
const { logger } = await import('@/lib/server/telemetry');
const { brainPageTitle } = await import('@/lib/shared/notion-brain');
const route = await import('@/app/api/projects/[id]/brain/notion/route');
const checkRoute = await import('@/app/api/projects/[id]/brain/notion/check/route');
const entityFactsRoute = await import('@/app/api/entities/[type]/[id]/facts/route');

registry.registerBuiltin(
  definePlugin({
    info: { id: 'productivity', name: 'Productivity (stand-in)', version: '0.0.0', language: 'typescript' },
    nodes: [],
    credentialTypes: [
      defineCredentialType({
        name: 'notionApi',
        displayName: 'Notion API',
        properties: [
          { name: 'apiKey', displayName: 'Internal Integration Secret', type: 'string', required: true, typeOptions: { password: true } },
          { name: 'baseUrl', displayName: 'API Base URL', type: 'string', default: 'https://api.notion.com' },
        ],
      }),
    ],
  }),
);

let fake: FakeNotion;
let credential = '';
let linked = '';
let unlinked = '';
let root = '';
const responses: string[] = [];
const logged: string[] = [];

let heard: BrainChange[] = [];
const stopListening = store.onBrainChange((change) => heard.push(change));
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function changes(fn: () => unknown): Promise<BrainChange[]> {
  heard = [];
  await fn();
  await flush();
  return heard;
}

const req = (method: string, url: string, body?: unknown) => new Request(`http://nb1-joins.test${url}`, { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
async function call(fn: () => Promise<Response>) {
  const response = await fn();
  const text = await response.text();
  responses.push(text);
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}

beforeAll(async () => {
  fake = await startFakeNotion({ botName: 'Landflow joins bot', workspaceName: 'Joins workspace' });
  for (const level of ['warn', 'info', 'error', 'debug'] as const) {
    const real = logger[level].bind(logger);
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
      return (real as (...a: unknown[]) => unknown)(...args);
    }) as never);
  }
  linked = projects.createTeamProject({ name: 'Payments' }).id;
  unlinked = projects.createTeamProject({ name: 'Ops' }).id;
  credential = credentials.create({ name: 'Notion joins key', type: 'productivity.notionApi', data: { apiKey: FAKE_NOTION_TOKEN, baseUrl: fake.url } }).id;
  replaceShares('credential', credential, [{ projectId: linked, role: 'user' }, { projectId: unlinked, role: 'user' }]);
  root = fake.addPage({ title: 'Payments wiki', shared: true });
});

afterAll(async () => {
  stopListening();
  vi.restoreAllMocks();
  await fake?.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe('join 2: the check runs through NB02\'s real client against the fake', () => {
  it('the client slot is filled by the runtime (no stub here) and speaks the contract\'s version', () => {
    expect(NOTION_VERSION).toBe('2026-03-11');
    expect(FAKE_NOTION_VERSION).toBe(NOTION_VERSION);
    const client = notionClientFor({ credentialId: credential });
    expect(typeof client.me).toBe('function');
  });

  it('answers the title, the counts and an existing brain; every request carried Notion-Version; nothing was written', async () => {
    store.brainStoreFor(linked).upsertEntity({ type: 'system', id: 'ledger', name: 'Ledger', projectId: linked } as never);
    const brain = fake.addPage({ parentId: root, title: brainPageTitle('Payments') });
    const before = fake.state.requests.length;
    const checked = await call(() => checkRoute.POST(req('POST', `/api/projects/${linked}/brain/notion/check`, { credentialId: credential, page: `https://www.notion.so/Payments-wiki-${root.replace(/-/g, '')}` }), params({ id: linked })));
    expect(checked.status).toBe(200);
    expect(checked.body).toMatchObject({
      title: 'Payments wiki',
      botName: 'Landflow joins bot',
      workspaceName: 'Joins workspace',
      existingBrain: { found: true, pageId: brain },
      counts: { pages: 1, facts: 0, practices: 0, notes: 0 },
    });
    const seen = fake.state.requests.slice(before);
    // The real client asked who the key is, read the page and walked its children.
    expect(seen.map((r) => r.template)).toEqual(expect.arrayContaining(['/v1/users/me', '/v1/pages/:id', '/v1/blocks/:id/children']));
    // The fake refuses a request without `Notion-Version: 2026-03-11` (400 missing_version) or the bearer token (401).
    expect(seen.every((r) => r.status === 200)).toBe(true);
    expect(seen.every((r) => r.method === 'GET')).toBe(true);
    expect(fake.writes()).toEqual([]);
  });

  it('an unshared page is the 404 that names the connection, still through the real client', async () => {
    const hidden = fake.addPage({ title: 'Private' });
    const checked = await call(() => checkRoute.POST(req('POST', `/api/projects/${linked}/brain/notion/check`, { credentialId: credential, page: hidden }), params({ id: linked })));
    expect(checked.status).toBe(404);
    expect(checked.body.error).toContain('Add connections → Landflow joins bot');
    expect(fake.writes()).toEqual([]);
  });
});

describe('join 1: the store and the links', () => {
  it('an active link makes the project\'s store report notion, and its writes are the local writes with one change for the project', async () => {
    expect(store.brainStoreFor(linked).backend).toBe('local');
    const made = await call(() => route.POST(req('POST', `/api/projects/${linked}/brain/notion`, { credentialId: credential, page: root }), params({ id: linked })));
    expect(made.status).toBe(202);
    expect(made.body).toMatchObject({ linked: true, projectId: linked, status: 'setting_up', credential: { id: credential, name: 'Notion joins key' } });
    expect(links.getLink(linked)).toBeDefined();

    const linkedStore = store.brainStoreFor(linked);
    expect(linkedStore.backend).toBe('notion');
    const written = await changes(() => linkedStore.upsertEntity({ type: 'initiative', id: 'checkout', name: 'Checkout', projectId: linked } as never));
    expect(database().get('SELECT project_id FROM brain_entities WHERE type = ? AND id = ?', 'initiative', 'checkout')).toEqual({ project_id: linked });
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ kind: 'entity', key: 'initiative/checkout', projectId: linked, op: 'upsert' });
    // Linking wrote nothing to Notion (nothing syncs in nb1).
    expect(fake.writes()).toEqual([]);
  });

  it('an unlinked project and no project are local; LANDFLOW_NOTION_BRAIN=off makes the linked one local too', () => {
    expect(store.brainStoreFor(unlinked).backend).toBe('local');
    expect(store.brainStoreFor(undefined).backend).toBe('local');
    process.env.LANDFLOW_NOTION_BRAIN = 'off';
    try {
      expect(store.brainStoreFor(linked).backend).toBe('local');
    } finally {
      delete process.env.LANDFLOW_NOTION_BRAIN;
    }
    expect(store.brainStoreFor(linked).backend).toBe('notion');
  });
});

describe('join 3: the change feed with a linked project', () => {
  it('a fact added through the entity route reaches a listener on the real port as one person change for the project', async () => {
    expect(store.brainStoreFor(linked).backend).toBe('notion');
    const added = await changes(async () => {
      const response = await call(() => entityFactsRoute.POST(req('POST', '/api/entities/initiative/checkout/facts', { kind: 'health', statement: 'On track' }), params({ type: 'initiative', id: 'checkout' })));
      expect(response.status).toBe(201);
    });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ kind: 'fact', projectId: linked, op: 'upsert', origin: 'person' });
    expect(database().get<{ n: number }>('SELECT COUNT(*) AS n FROM brain_facts WHERE project_id = ?', linked)!.n).toBe(1);
  });
});

describe('the key stays in the vault', () => {
  it('no response, audit row, stored link or captured log line holds the key', () => {
    expect(responses.length).toBeGreaterThan(0);
    expect(responses.join('\n')).not.toContain(FAKE_NOTION_TOKEN);
    const audit = JSON.stringify(queryEvents({}, { limit: 1000 }).events);
    expect(audit).toContain('notion-brain.link');
    expect(audit).not.toContain(FAKE_NOTION_TOKEN);
    expect(JSON.stringify(database().all('SELECT * FROM notion_brain_links'))).not.toContain(FAKE_NOTION_TOKEN);
    expect(logged.join('\n')).not.toContain(FAKE_NOTION_TOKEN);
  });
});

describe('join 4: the contract copies', () => {
  it.skipIf(!process.env.LANDFLOW_BACKBONE_CONTRACTS)('the five repo copies equal backbone/contracts/nb byte for byte', () => {
    const dir = process.env.LANDFLOW_BACKBONE_CONTRACTS!;
    const src = join(__dirname, '..', 'src', 'lib');
    const same = (copy: string, contract: string) => expect(readFileSync(copy, 'utf8'), contract).toBe(readFileSync(join(dir, 'nb', contract), 'utf8'));
    same(join(src, 'shared', 'brain-store.ts'), 'brain-store.ts');
    same(join(src, 'server', 'brain', 'store', 'port.ts'), 'brain-store-port.ts');
    same(join(src, 'server', 'notion', 'port.ts'), 'notion-port.ts');
    same(join(__dirname, 'fake-notion.ts'), 'fake-notion.ts');
    same(join(src, 'shared', 'notion-brain.ts'), 'notion-brain.ts');
  });
});
