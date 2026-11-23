/**
 * C22 (W4b P21): the routes of knowledge sources, called as real people (an owner, a member of another project): create, list,
 * pause and change, remove with and without the chunks (audited with a credential's name, never a value), the credentials an
 * agent's project may use (403) and of the right type (400), Sync now (202, and 409 while one runs), the runs paged, 404 for
 * whoever may not update the agent, the 20 sources of a base, and a site address the outbound policy refuses (AS-5).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VectorKnowledgeBaseConfig } from '@/lib/shared/agents';
import { fakeSite } from '@landflow/test-fakes/site';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-ks-routes-'));
const filesDir = join(dataDir, 'files');
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_FILES_DIR: filesDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });
const folderOf = (name: string, text = '# Disk\n\nFree space with the cleanup job.\n') => {
  mkdirSync(join(filesDir, name), { recursive: true });
  writeFileSync(join(filesDir, name, 'disk.md'), text);
  return name;
};

const auth = await import('@/lib/server/auth');
const projects = await import('@/lib/server/projects');
const { setHomeProject } = await import('@/lib/server/projects/store');
const { agentStore } = await import('@/lib/server/agents/store');
const knowledge = await import('@/lib/server/agents/knowledge');
const access = await import('@/lib/server/rag/collection-access');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { credentials } = await import('@/lib/server/credentials/vault');
const { queryEvents } = await import('@/lib/server/audit/store');
const claim = await import('@/lib/server/knowledge-sources/claim');
const store = await import('@/lib/server/knowledge-sources/store');
const listRoute = await import('@/app/api/agents/[id]/knowledge/[toolId]/sources/route');
const oneRoute = await import('@/app/api/agents/[id]/knowledge/[toolId]/sources/[sourceId]/route');
const syncRoute = await import('@/app/api/agents/[id]/knowledge/[toolId]/sources/[sourceId]/sync/route');
const runsRoute = await import('@/app/api/agents/[id]/knowledge/[toolId]/sources/[sourceId]/runs/route');
const { defineCredentialType, definePlugin } = await import('@landflow/sdk');

const unique = (name: string) => `${name}-${Math.random().toString(36).slice(2, 7)}`;
const base = (collection: string): VectorKnowledgeBaseConfig => ({ id: 'kb1', type: 'knowledge', source: 'vector', name: 'search_docs', description: 'Search the docs', store: 'memory', collection, embeddings: { provider: 'none', model: 'bm25' }, topK: 4 });

let A = '';
let B = '';
let owner: Awaited<ReturnType<typeof auth.createOwner>>;
let alice: Awaited<ReturnType<typeof auth.createUser>>;
let ownerSession = '';
let aliceSession = '';
const site = fakeSite();

beforeAll(async () => {
  mkdirSync(filesDir, { recursive: true });
  auth.disableTestAuth();
  owner = await auth.createOwner({ email: 'owner@example.com', name: 'Olive', password: 'password-123' });
  ownerSession = auth.createSession(owner, 'password').token;
  alice = await auth.createUser({ email: 'alice@example.com', name: 'Alice', role: 'member', password: 'password-123' });
  aliceSession = auth.createSession(alice, 'password').token;
  A = projects.createTeamProject({ name: 'Alpha' }).id;
  B = projects.createTeamProject({ name: 'Beta' }).id;
  projects.setMember(B, alice.id, 'admin');
  access.collectionAccess('memory:__warm__', A);
  registry.registerBuiltin(corePlugin);
  registry.registerBuiltin(
    definePlugin({
      info: { id: 'google', name: 'Google', version: '1.0.0', language: 'typescript' },
      credentialTypes: [defineCredentialType({ name: 'googleOAuth2Api', displayName: 'Google OAuth2', extends: ['oAuth2Api'], properties: [] })],
      nodes: [],
    }),
  );
  await site.start();
});
afterAll(async () => {
  await site.stop();
  rmSync(dataDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

function agentIn(project: string) {
  const agent = agentStore.create({ name: unique('agent'), tools: [base(unique('docs'))] });
  setHomeProject('agent', agent.id, project);
  return agent;
}

type Route = (request: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(route: unknown, method: string, agentId: string, extra: { sourceId?: string; json?: unknown; query?: string; session?: string; toolId?: string } = {}) {
  const toolId = extra.toolId ?? 'kb1';
  const headers: Record<string, string> = { cookie: `landflow_session=${extra.session ?? ownerSession}`, ...(extra.json !== undefined && { 'content-type': 'application/json' }) };
  const response = await (route as Route)(new Request(`http://localhost:3000/api/agents/${agentId}/knowledge/${toolId}/sources${extra.sourceId ? `/${extra.sourceId}` : ''}${extra.query ?? ''}`, { method, headers, ...(extra.json !== undefined && { body: JSON.stringify(extra.json) }) }), {
    params: Promise.resolve({ id: agentId, toolId, ...(extra.sourceId && { sourceId: extra.sourceId }) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
const create = (agentId: string, json: unknown, session?: string) => call(listRoute.POST, 'POST', agentId, { json, ...(session && { session }) });
const folderInput = (folder: string, schedule = 'manual') => ({ kind: 'folder', settings: { folder }, schedule });
const settled = async (sourceId: string) => {
  for (let i = 0; i < 200; i++) {
    const row = claim.stateOf(sourceId);
    if (!row?.run_id && store.listRuns(sourceId).runs.length) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the sync did not finish');
};
const events = (agentId: string) => queryEvents({ targetId: agentId }, { limit: 100 }).events.filter((e) => e.action.startsWith('knowledge_source.'));

describe('creating, listing, changing, removing', () => {
  it('adds a folder source, lists it, pauses it, sets hourly, and removes it; each change is audited', async () => {
    const agent = agentIn(A);
    const made = await create(agent.id, folderInput(folderOf(unique('runbooks'))));
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ kind: 'folder', schedule: 'manual', paused: false, running: false });
    const id = made.body.id as string;
    expect((await call(listRoute.GET, 'GET', agent.id)).body.sources.map((s: { id: string }) => s.id)).toEqual([id]);

    const hourly = await call(oneRoute.PATCH, 'PATCH', agent.id, { sourceId: id, json: { schedule: 'hourly' } });
    expect(hourly.body.schedule).toBe('hourly');
    expect(hourly.body.nextAt).toBeTruthy();
    const paused = await call(oneRoute.PATCH, 'PATCH', agent.id, { sourceId: id, json: { paused: true } });
    expect(paused.body).toMatchObject({ paused: true });
    expect(paused.body.nextAt).toBeUndefined();
    const resumed = await call(oneRoute.PATCH, 'PATCH', agent.id, { sourceId: id, json: { paused: false } });
    expect(resumed.body).toMatchObject({ paused: false });
    expect(resumed.body.nextAt).toBeTruthy();

    const removed = await call(oneRoute.DELETE, 'DELETE', agent.id, { sourceId: id });
    expect(removed.body).toEqual({ removedChunks: 0 });
    expect((await call(listRoute.GET, 'GET', agent.id)).body.sources).toEqual([]);
    expect(events(agent.id).map((e) => e.action).sort()).toEqual(['knowledge_source.created', 'knowledge_source.removed', 'knowledge_source.updated', 'knowledge_source.updated', 'knowledge_source.updated']);
  });

  it('the same place twice is 409; a folder outside the files directory or missing is 400', async () => {
    const agent = agentIn(A);
    const folder = folderOf(unique('twice'));
    expect((await create(agent.id, folderInput(folder))).status).toBe(201);
    expect((await create(agent.id, folderInput(`${folder}/`))).status).toBe(409);
    expect((await create(agent.id, folderInput('../outside'))).status).toBe(400);
    expect((await create(agent.id, folderInput('no-such-folder'))).status).toBe(400);
    expect((await create(agent.id, { kind: 'folder', settings: { folder }, schedule: 'weekly' })).status).toBe(400);
  });

  it('removing with the chunks deletes only what the source wrote and audits it (AS-9); keeping them leaves them', async () => {
    const agent = agentIn(A);
    const config = knowledge.knowledgeConfigOf(agent.id, 'kb1')!;
    const internal = { asProject: A, subject: 'agent' as const };
    await knowledge.addKnowledgeDocument(config, { bytes: new TextEncoder().encode('# Mine\n\nA hand-uploaded note.'), fileName: 'note.md' }, {}, internal);
    const made = await create(agent.id, folderInput(folderOf(unique('wipe'))));
    const id = made.body.id as string;
    expect((await call(syncRoute.POST, 'POST', agent.id, { sourceId: id })).status).toBe(202);
    await settled(id);
    expect((await knowledge.listKnowledgeDocuments(config, internal)).documents).toHaveLength(2);

    const kept = await create(agent.id, folderInput(folderOf(unique('keep'))));
    expect((await call(syncRoute.POST, 'POST', agent.id, { sourceId: kept.body.id })).status).toBe(202);
    await settled(kept.body.id);
    expect((await call(oneRoute.DELETE, 'DELETE', agent.id, { sourceId: kept.body.id })).body.removedChunks).toBe(0);
    expect((await knowledge.listKnowledgeDocuments(config, internal)).documents).toHaveLength(3);

    const wiped = await call(oneRoute.DELETE, 'DELETE', agent.id, { sourceId: id, query: '?deleteChunks=1' });
    expect(wiped.body.removedChunks).toBeGreaterThan(0);
    expect((await knowledge.listKnowledgeDocuments(config, internal)).documents.map((d) => d.fileName).sort()).toEqual(['disk.md', 'note.md']); // the other source's file and the upload stay
    const removedEvent = events(agent.id).find((e) => e.action === 'knowledge_source.removed' && e.details?.sourceId === id)!;
    expect(removedEvent.details).toMatchObject({ deletedChunks: true });
    expect(removedEvent.summary).toMatch(/and \d+ chunks?/);
  });
});

describe('the same place, collection-wide (review)', () => {
  it('changing a source to a place another source of the same collection has is 409, also when that source is on another agent; removing leaves no state', async () => {
    const one = agentIn(A);
    const first = folderOf(unique('shared-a'));
    const second = folderOf(unique('shared-b'));
    const a = await create(one.id, folderInput(first));
    const b = await create(one.id, folderInput(second));
    const clash = await call(oneRoute.PATCH, 'PATCH', one.id, { sourceId: b.body.id, json: { settings: { folder: first } } });
    expect(clash.status).toBe(409);
    expect(store.getSource(b.body.id)!.location).toBe(second);
    // a second agent on the same collection: its source for the same folder is the same place
    const twin = agentStore.create({ name: unique('twin'), tools: [one.tools[0]] });
    setHomeProject('agent', twin.id, A);
    expect((await create(twin.id, folderInput(first))).status).toBe(409);
    const moved = await call(oneRoute.PATCH, 'PATCH', one.id, { sourceId: b.body.id, json: { settings: { folder: folderOf(unique('free')) } } });
    expect(moved.status).toBe(200);
    expect((await call(oneRoute.DELETE, 'DELETE', one.id, { sourceId: a.body.id })).status).toBe(200);
    expect(claim.stateOf(a.body.id)).toBeUndefined();
  });
});

describe('credentials (AS-10)', () => {
  const s3Credential = (project?: string) => {
    const credential = credentials.create({ name: unique('LocalStack'), type: 'core.s3Api', data: { endpoint: 'http://127.0.0.1:54566', region: 'us-east-1', accessKeyId: 'AKIADUMMYKEYFORTESTS', secretAccessKey: 'dummy-secret-for-tests-only', forcePathStyle: true } as never });
    if (project) setHomeProject('credential', credential.id, project);
    return credential;
  };
  const s3Input = (credentialId: string, prefix = 'guides/') => ({ kind: 's3', settings: { bucket: 'docs', prefix }, credentialId, schedule: 'manual' });

  it('an S3 source with a credential its agent’s project may use; the audit names the credential and holds no secret', async () => {
    const agent = agentIn(A);
    const credential = s3Credential(A);
    const made = await create(agent.id, s3Input(credential.id));
    expect(made.status).toBe(201);
    expect(made.body.credential).toEqual({ id: credential.id, name: credential.name });
    expect(JSON.stringify(made.body)).not.toContain('dummy-secret');
    const event = events(agent.id).find((e) => e.action === 'knowledge_source.created')!;
    expect(event.details).toMatchObject({ credential: credential.name, credentialId: credential.id });
    expect(JSON.stringify(event)).not.toMatch(/dummy-secret|AKIADUMMY/);
  });

  it('a credential the agent’s project can’t use is 403; one of the wrong type or none is 400', async () => {
    const agent = agentIn(A);
    expect((await create(agent.id, s3Input(s3Credential(B).id))).status).toBe(403);
    const wrong = credentials.create({ name: unique('OpenAI'), type: 'core.openAiApi', data: { apiKey: 'k' } as never });
    setHomeProject('credential', wrong.id, A);
    expect((await create(agent.id, s3Input(wrong.id))).status).toBe(400);
    expect((await create(agent.id, { kind: 's3', settings: { bucket: 'docs', prefix: '' }, schedule: 'manual' })).status).toBe(400);
    expect((await create(agent.id, s3Input('cred-does-not-exist'))).status).toBe(400);
    expect((await create(agent.id, { kind: 's3', settings: { bucket: 'Not_A_Bucket', prefix: '' }, credentialId: s3Credential(A).id, schedule: 'manual' })).status).toBe(400);
  });

  it('a Drive source needs a Google OAuth2 credential', async () => {
    const agent = agentIn(A);
    const google = credentials.create({ name: unique('Drive'), type: 'google.googleOAuth2Api', data: { clientId: 'c', clientSecret: 's', authUrl: 'http://127.0.0.1:1/authorize', accessTokenUrl: 'http://127.0.0.1:1/token' } as never });
    setHomeProject('credential', google.id, A);
    const made = await create(agent.id, { kind: 'googleDrive', settings: { folderId: '1AbCdEfGhIjKlMn', includeSubfolders: true }, credentialId: google.id, schedule: 'daily' });
    expect(made.status).toBe(201);
    expect(made.body.settings).toEqual({ folderId: '1AbCdEfGhIjKlMn', includeSubfolders: true });
    expect((await create(agent.id, { kind: 'googleDrive', settings: { folderId: '1AbCdEfGhIjKlMn' }, credentialId: s3Credential(A).id, schedule: 'daily' })).status).toBe(400);
    expect((await create(agent.id, { kind: 'googleDrive', settings: { folderId: "x' or '1'='1" }, credentialId: google.id, schedule: 'daily' })).status).toBe(400);
  });
});

describe('a site source and the outbound policy (AS-5)', () => {
  it('a start address on a private network is refused when private addresses are blocked, with LANDFLOW_OUTBOUND_ALLOW as the way in', async () => {
    const agent = agentIn(A);
    const input = (startUrl: string) => ({ kind: 'crawl', settings: { startUrl, maxDepth: 2, maxPages: 50 }, schedule: 'manual' });
    process.env.LANDFLOW_OUTBOUND_BLOCK_PRIVATE = 'true';
    try {
      const refused = await create(agent.id, input('http://10.0.0.5/'));
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/Blocked/);
      expect((await create(agent.id, input(`${site.url}/`))).status).toBe(400); // 127.0.0.1
      expect((await create(agent.id, input('http://localhost:8080/'))).status).toBe(400);
      process.env.LANDFLOW_OUTBOUND_ALLOW = '127.0.0.1';
      expect((await create(agent.id, input(`${site.url}/`))).status).toBe(201);
    } finally {
      delete process.env.LANDFLOW_OUTBOUND_BLOCK_PRIVATE;
      delete process.env.LANDFLOW_OUTBOUND_ALLOW;
    }
  });

  it('in development a local site saves; limits and shapes are checked', async () => {
    const agent = agentIn(A);
    const made = await create(agent.id, { kind: 'crawl', settings: { startUrl: `${site.url}/docs#top`, maxDepth: 3, maxPages: 500 }, schedule: 'daily' });
    expect(made.status).toBe(201);
    expect(made.body.settings).toEqual({ startUrl: `${site.url}/docs`, maxDepth: 3, maxPages: 500 });
    const bad = (settings: Record<string, unknown>) => create(agent.id, { kind: 'crawl', settings, schedule: 'manual' }).then((r) => r.status);
    expect(await bad({ startUrl: `${site.url}/`, maxDepth: 4 })).toBe(400);
    expect(await bad({ startUrl: `${site.url}/`, maxPages: 501 })).toBe(400);
    expect(await bad({ startUrl: 'ftp://example.test/' })).toBe(400);
    expect(await bad({ startUrl: 'not a url' })).toBe(400);
    expect(await bad({ startUrl: 'http://user:pass@example.test/' })).toBe(400);
  });
});

describe('Sync now and the runs', () => {
  it('answers 202 with the run id; a second while one holds the source is 409 and names it (AS-7); the runs page newest first', async () => {
    const agent = agentIn(A);
    const made = await create(agent.id, folderInput(folderOf(unique('sync'))));
    const id = made.body.id as string;
    const first = await call(syncRoute.POST, 'POST', agent.id, { sourceId: id });
    expect(first.status).toBe(202);
    await settled(id);
    for (let i = 0; i < 2; i++) {
      expect((await call(syncRoute.POST, 'POST', agent.id, { sourceId: id })).status).toBe(202);
      await settled(id);
    }
    const runs = await call(runsRoute.GET, 'GET', agent.id, { sourceId: id, query: '?limit=2' });
    expect(runs.body.runs).toHaveLength(2);
    expect(runs.body.runs[0].startedAt >= runs.body.runs[1].startedAt).toBe(true);
    expect(runs.body.runs[0]).toMatchObject({ trigger: 'manual', status: 'ok', counts: { seen: 1 } });
    const page2 = await call(runsRoute.GET, 'GET', agent.id, { sourceId: id, query: `?limit=2&cursor=${runs.body.next}` });
    expect(page2.body.runs).toHaveLength(1);
    expect(page2.body.runs[0].id).toBe(first.body.runId);
    expect((await call(runsRoute.GET, 'GET', agent.id, { sourceId: id, query: '?limit=999' })).status).toBe(400);
    expect((await call(runsRoute.GET, 'GET', agent.id, { sourceId: id, query: '?cursor=nonsense' })).status).toBe(400);

    // another process holds the source: Sync now says so, and so does Remove
    expect(await claim.claimSource(id, 'run-elsewhere', Date.now())).toBe(true);
    const busy = await call(syncRoute.POST, 'POST', agent.id, { sourceId: id });
    expect(busy.status).toBe(409);
    expect(busy.body).toMatchObject({ error: 'A sync of this source is running', runId: 'run-elsewhere' });
    expect((await call(oneRoute.DELETE, 'DELETE', agent.id, { sourceId: id })).status).toBe(409);
    expect((await call(listRoute.GET, 'GET', agent.id)).body.sources[0].running).toBe(true);
    await claim.releaseSource(id, 'run-elsewhere', null);
    expect((await call(oneRoute.DELETE, 'DELETE', agent.id, { sourceId: id })).status).toBe(200);
  });
});

describe('who may', () => {
  it('a person who can’t update the agent gets 404 on every route; a source of another base is 404 too', async () => {
    const agent = agentIn(A);
    const other = agentIn(A);
    const made = await create(agent.id, folderInput(folderOf(unique('private'))));
    const id = made.body.id as string;
    const as = { session: aliceSession }; // a member of Beta only
    expect((await call(listRoute.GET, 'GET', agent.id, as)).status).toBe(404);
    expect((await create(agent.id, folderInput(folderOf(unique('x'))), aliceSession)).status).toBe(404);
    expect((await call(oneRoute.PATCH, 'PATCH', agent.id, { ...as, sourceId: id, json: { paused: true } })).status).toBe(404);
    expect((await call(oneRoute.DELETE, 'DELETE', agent.id, { ...as, sourceId: id })).status).toBe(404);
    expect((await call(syncRoute.POST, 'POST', agent.id, { ...as, sourceId: id })).status).toBe(404);
    expect((await call(runsRoute.GET, 'GET', agent.id, { ...as, sourceId: id })).status).toBe(404);
    // the owner, but the wrong base or agent
    expect((await call(oneRoute.PATCH, 'PATCH', other.id, { sourceId: id, json: { paused: true } })).status).toBe(404);
    expect((await call(syncRoute.POST, 'POST', agent.id, { sourceId: id, toolId: 'kb9' })).status).toBe(404);
    expect((await call(listRoute.GET, 'GET', agent.id, { toolId: 'kb9' })).status).toBe(404);
    expect(store.getSource(id)!.paused).toBe(0);
  });

  it('a base holds 20 sources at most', async () => {
    const agent = agentIn(A);
    for (let i = 0; i < 20; i++) expect((await create(agent.id, folderInput(folderOf(unique(`cap${i}`))))).status).toBe(201);
    const over = await create(agent.id, folderInput(folderOf(unique('cap21'))));
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/20 sources/);
  });
});
