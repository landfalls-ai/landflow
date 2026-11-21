/**
 * C07: a plugin as a project's memory provider (docs/protocol.md#memory-providers): the remote backend calls a local fake
 * provider over HTTP, a failing provider fails the call and never falls back, and the project setting checks the node.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MEMORY_OPERATIONS, MEMORY_OUTPUT_REQUIRED, type MemoryRequestWire, type PluginManifest } from '@landflow/protocol';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-memory-provider-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { createUser } = await import('@/lib/server/auth/users');
const { createTeamProject, setMember } = await import('@/lib/server/projects/store');
const { updateProjectSettings } = await import('@/lib/server/governance/scopes');
const facts = await import('@/lib/server/brain/facts');
const { database } = await import('@/lib/server/db');
const { memory } = await import('@/lib/server/memory');
const { setProviderTimeoutMs } = await import('@/lib/server/memory/remote');
const settingsRoute = await import('@/app/api/projects/[id]/settings/route');
const brainFacts = facts;

registry.registerBuiltin(corePlugin);

const out = (op: (typeof MEMORY_OPERATIONS)[number]) => ({ type: 'object', required: [...MEMORY_OUTPUT_REQUIRED[op]] });
const manifest: PluginManifest = {
  protocol: 'landflow.plugin/v1',
  plugin: { id: 'fakemem', name: 'Fake memory', version: '1.0.0', language: 'typescript' },
  nodes: [
    {
      name: 'store',
      displayName: 'Fake memory store',
      description: 'A memory provider for tests',
      version: 1,
      kind: 'action',
      memoryProvider: true,
      inputs: [{ type: 'main' }],
      outputs: [{ type: 'main' }],
      properties: [{ name: 'operation', displayName: 'Operation', type: 'options', default: 'search', options: MEMORY_OPERATIONS.map((op) => ({ name: op, value: op, outputSchema: out(op) })) }],
    },
  ],
};

const received: MemoryRequestWire[] = [];
let mode: 'ok' | 'hang' | 'error' = 'ok';
const item = (text: string) => ({ id: 'ext_1', text, kind: 'memory', score: 0.9, version: 1, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' });
let server: Server;
let endpoint = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const send = (body: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/landflow/v1/manifest') return send(manifest);
      if (req.url === '/landflow/v1/health') return send({ status: 'ok' });
      if (req.url === '/landflow/v1/execute') {
        if (mode === 'hang') return; // never answers
        if (mode === 'error') return send({ outputs: [], error: { message: 'the vector database is down' } });
        const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { inputs: Array<Array<{ json: MemoryRequestWire }>> };
        const wire = request.inputs[0][0].json;
        received.push(wire);
        if (wire.operation === 'search') return send({ outputs: [[{ json: { items: [item('From the provider')] } }]] });
        if (wire.operation === 'profile') return send({ outputs: [[{ json: { static: [], recent: [item('Recent one')] } }]] });
        if (wire.operation === 'list') return send({ outputs: [[{ json: { items: [item('Listed')], nextCursor: 'c2' } }]] });
        return send({ outputs: [[{ json: { item: item(wire.operation === 'add' ? wire.text : 'forgotten') } }]] });
      }
      send({ error: 'not found' }, 404);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await registry.addEndpoint(endpoint, 'static', undefined, { local: true });
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

let projectId = '';
let caller: import('@/lib/server/memory').MemoryCaller;
let owner: { id: string };
beforeAll(async () => {
  owner = await createUser({ email: 'prov@mem.test', name: 'Prov', role: 'owner', password: 'prov-password-1' });
  projectId = createTeamProject({ name: 'Prov', createdBy: owner.id }).id;
  setMember(projectId, owner.id, 'admin');
  caller = { actor: { id: owner.id, role: 'owner' }, origin: 'person', userId: owner.id };
  facts.upsertFact({ id: `project:${projectId}:memory:builtin1`, subjectType: 'project', subjectId: projectId, kind: 'memory', statement: 'Only the built-in store has this', confidence: 1, evidence: [], projectId } as never, database(), new Date().toISOString());
});

describe('T-7 the remote backend', () => {
  it('registers the provider', () => {
    expect(registry.resolve('fakemem.store')).toMatchObject({ descriptor: { memoryProvider: true } });
  });

  it('calls the provider for a project set to it and maps its items (AS-6)', async () => {
    updateProjectSettings(projectId, { memory: { backend: 'provider', nodeType: 'fakemem.store' } } as never, owner.id);
    received.length = 0;
    const found = await memory.search({ kind: 'project', id: projectId }, 'anything', { mode: 'keyword', limit: 3, threshold: 0.2 }, caller);
    expect(received[0]).toEqual({ operation: 'search', container: `project:${projectId}`, query: 'anything', mode: 'keyword', limit: 3, threshold: 0.2 });
    expect(found.items).toEqual([expect.objectContaining({ id: 'ext_1', text: 'From the provider', source: 'provider', score: 0.9, kind: 'memory' })]);
    // not the built-in fact
    expect(found.items.map((i) => i.text)).not.toContain('Only the built-in store has this');
  });

  it('sends add, forget, profile and list in the wire shapes', async () => {
    received.length = 0;
    const c = { kind: 'project' as const, id: projectId };
    const added = await memory.add(c, { text: 'Remember this', kind: 'memory', static: true, replaces: 'ext_0' }, caller);
    expect(added.text).toBe('Remember this');
    await memory.forget(c, 'ext_1', 'wrong', caller);
    expect((await memory.profile(c, caller)).recent[0].text).toBe('Recent one');
    const page = await memory.list(c, { limit: 5 }, caller);
    expect(page.nextCursor).toBe('c2');
    expect(received).toEqual([
      { operation: 'add', container: `project:${projectId}`, text: 'Remember this', kind: 'memory', static: true, replaces: 'ext_0' },
      { operation: 'forget', id: 'ext_1', reason: 'wrong' },
      { operation: 'profile', container: `project:${projectId}` },
      { operation: 'list', container: `project:${projectId}`, limit: 5 },
    ]);
  });

  it('fails with the provider’s message and never reads the built-in store (AS-7)', async () => {
    mode = 'error';
    const spy = vi.spyOn(brainFacts, 'scoredFactSearch');
    await expect(memory.search({ kind: 'project', id: projectId }, 'x', {}, caller)).rejects.toMatchObject({ name: 'MemoryProviderError', status: 502, message: expect.stringContaining('the vector database is down') });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('times out when the provider stops answering', async () => {
    mode = 'hang';
    setProviderTimeoutMs(600);
    const started = Date.now();
    await expect(memory.search({ kind: 'project', id: projectId }, 'x', {}, caller)).rejects.toMatchObject({ name: 'MemoryProviderError' });
    expect(Date.now() - started).toBeLessThan(5_000);
    mode = 'ok';
    setProviderTimeoutMs(undefined);
  });

  it('still checks access before calling the provider', async () => {
    const stranger = await createUser({ email: 'stranger@mem.test', name: 'S', role: 'member', password: 'stranger-password-1' });
    received.length = 0;
    await expect(memory.search({ kind: 'project', id: projectId }, 'x', {}, { actor: { id: stranger.id, role: 'member' }, origin: 'person' })).rejects.toMatchObject({ name: 'MemoryNotFoundError' });
    expect(received).toEqual([]);
  });

  it('goes back to the built-in store when the setting says so', async () => {
    updateProjectSettings(projectId, { memory: { backend: 'built-in' } } as never, owner.id);
    const found = await memory.search({ kind: 'project', id: projectId }, 'built-in', { mode: 'keyword' }, caller);
    expect(found.items.map((i) => i.text)).toEqual(['Only the built-in store has this']);
  });
});

describe('T-7 the project setting', () => {
  const patch = async (body: unknown) => {
    const response = await settingsRoute.PATCH(new Request(`http://landflow.test/api/projects/${projectId}/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: projectId }) });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };

  it('accepts a provider node and reads it back', async () => {
    const saved = await patch({ memory: { backend: 'provider', nodeType: 'fakemem.store' } });
    expect(saved.status).toBe(200);
    expect(saved.body.settings.memory).toEqual({ backend: 'provider', nodeType: 'fakemem.store' });
  });

  it('refuses a node type that is not a memory provider, and an unknown one', async () => {
    const core = await patch({ memory: { backend: 'provider', nodeType: 'core.set' } });
    expect(core.status).toBe(400);
    expect(core.body.error).toMatch(/memory provider/);
    expect((await patch({ memory: { backend: 'provider', nodeType: 'nope.nothing' } })).status).toBe(400);
  });

  it('refuses a credential the project cannot use', async () => {
    const saved = await patch({ memory: { backend: 'provider', nodeType: 'fakemem.store', credentialId: 'cred_not_here' } });
    expect(saved.status).toBe(400);
    expect(saved.body.error).toMatch(/credential/i);
  });

  it('clears with null', async () => {
    const cleared = await patch({ memory: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.settings.memory).toBeUndefined();
  });
});
