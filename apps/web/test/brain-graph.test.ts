/**
 * C10: the memory graph route and builder (docs/second-brain.md#the-graph): subjects and facts as nodes, `about` edges, version
 * edges with history on, paging by cursor, and what a member may see. Handlers are called directly as a signed-in user.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-brain-graph-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { store } = await import('@/lib/server/store');
const { database } = await import('@/lib/server/db');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const entities = await import('@/lib/server/brain/entities');
const facts = await import('@/lib/server/brain/facts');
const { forgetFact } = await import('@/lib/server/brain/fact-lifecycle');
const { createTeamProject, setHomeProject, setMember } = await import('@/lib/server/projects/store');
const route = await import('@/app/api/brain/graph/route');
const { parseSubject } = await import('@/lib/server/brain/graph');
import type { GraphPage } from '@/lib/shared/brain-graph';

const owner = await createUser({ email: 'owner@graph.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
const alice = await createUser({ email: 'alice@graph.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
const teamA = createTeamProject({ name: 'Alpha', createdBy: owner.id });
const teamB = createTeamProject({ name: 'Beta', createdBy: owner.id });
setMember(teamA.id, alice.id, 'editor');

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const get = async (query = ''): Promise<{ status: number; body: GraphPage & Record<string, unknown> }> => {
  const response = await route.GET(new Request(`http://graph.test/api/brain/graph${query}`));
  return { status: response.status, body: (await response.json()) as never };
};
const at = (n: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString();
const acme = (kind: string, statement: string, n: number) =>
  facts.upsertFact({ subjectType: 'entity', subjectId: 'customer/acme', kind: kind as 'health', statement, confidence: 0.7, evidence: [] } as never, database(), at(n));

function clear() {
  const db = database();
  for (const [table, column] of Object.entries({ brain_entities: 'created_at', brain_facts: 'last_seen' } as const)) db.deleteBefore(table as 'brain_facts', column, '9999');
}

beforeEach(() => {
  clear();
  enableTestAuth(owner);
  entities.upsertEntity({ type: 'customer', id: 'acme', name: 'Acme', projectId: teamA.id });
  acme('purpose', 'Acme buys the Pro plan', 1);
  acme('cost', 'Acme spends 40 a month', 2);
  acme('failure', 'Acme sees timeouts on import', 3);
  acme('health', 'Acme is healthy', 4);
  acme('health', 'Acme is at risk', 5);
  acme('health', 'Acme churned', 6);
});

describe('the builder', () => {
  it('shows Acme, its four facts and four About edges, and no version edges (AS-1)', async () => {
    const { status, body } = await get('?about=customer/acme');
    expect(status).toBe(200);
    expect(body.nodes.filter((n) => n.kind === 'subject').map((n) => (n as { label: string }).label)).toEqual(['Acme']);
    expect(body.nodes.filter((n) => n.kind === 'fact')).toHaveLength(4);
    expect(body.edges.filter((e) => e.type === 'about')).toHaveLength(4);
    expect(body.edges).toHaveLength(4);
    expect(body.nextCursor).toBeUndefined();
  });

  it('adds the earlier versions and two updates edges with history on (AS-2)', async () => {
    const { body } = await get('?about=entity/customer/acme&history=1');
    expect(body.nodes.filter((n) => n.kind === 'fact')).toHaveLength(6);
    const updates = body.edges.filter((e) => e.type === 'updates');
    expect(updates).toHaveLength(2);
    const latest = body.nodes.filter((n) => n.kind === 'fact' && n.latest);
    expect(latest).toHaveLength(4);
    // Each updates edge runs from a version to the next one: v1 -> v2 -> v3.
    const byId = new Map(body.nodes.map((n) => [n.id, n]));
    expect(updates.map((e) => [(byId.get(e.from) as { version: number }).version, (byId.get(e.to) as { version: number }).version]).sort()).toEqual([[1, 2], [2, 3]]);
  });

  it('keeps a statement as plain text and leaves a trimmed one empty (AS-5 data)', async () => {
    acme('usage', '<script>alert(1)</script>', 7);
    const { body } = await get('?about=customer/acme');
    expect(body.nodes.some((n) => n.kind === 'fact' && n.statement === '<script>alert(1)</script>')).toBe(true);
  });

  it('marks a forgotten fact, only when asked and only to someone who may restore it', async () => {
    await forgetFact('entity:customer/acme:cost', { reason: 'secret reason words' }, { userId: owner.id });
    const plain = await get('?about=customer/acme');
    expect(plain.body.nodes.filter((n) => n.kind === 'fact')).toHaveLength(3);
    const shown = await get('?about=customer/acme&forgotten=1');
    const forgotten = shown.body.nodes.filter((n) => n.kind === 'fact' && n.forgotten);
    expect(forgotten).toHaveLength(1);
    // The reason and who forgot it never leave in the graph.
    const text = JSON.stringify(shown.body);
    expect(text).not.toContain('secret reason words');
    expect(text).not.toContain(owner.id);
  });

  it('shows no forgotten node to a member who can read the page but not change it', async () => {
    const viewer = await createUser({ email: 'viewer@graph.test', name: 'Viewer', role: 'member', password: 'viewer-password-1' });
    setMember(teamA.id, viewer.id, 'viewer');
    await forgetFact('entity:customer/acme:cost', { reason: 'secret reason words' }, { userId: owner.id });
    enableTestAuth(viewer);
    const plain = await get('?about=customer/acme&forgotten=1');
    expect(plain.status).toBe(200);
    expect(plain.body.nodes.filter((n) => n.kind === 'fact')).toHaveLength(3);
    expect(plain.body.nodes.some((n) => n.kind === 'fact' && n.forgotten)).toBe(false);
    expect(JSON.stringify(plain.body)).not.toContain('secret reason words');
    enableTestAuth(owner);
  });

  it('never shows an agent-user fact', async () => {
    database().upsert('brain_facts', facts.factRow({ id: 'x:1', subjectType: 'agent-user', subjectId: 'a1', kind: 'health', statement: 'private', evidence: [], confidence: 1, firstSeen: at(1), lastSeen: at(30), status: 'active' } as never));
    expect(JSON.stringify((await get()).body)).not.toContain('private');
  });

  it('shows a project memory fact as a subject named after the project, with the memory kind', async () => {
    facts.upsertFact({ subjectType: 'project', subjectId: teamA.id, kind: 'memory', statement: 'Alpha ships on Fridays', confidence: 0.9, evidence: [], projectId: teamA.id } as never, database(), at(40));
    const whole = await get();
    expect(whole.body.nodes.some((n) => n.kind === 'subject' && n.subjectType === 'project' && n.label === 'Alpha')).toBe(true);
    const one = await get(`?about=project/${teamA.id}`);
    expect(one.status).toBe(200);
    expect(one.body.nodes.filter((n) => n.kind === 'fact').map((n) => (n as { factKind: string }).factKind)).toEqual(['memory']);
  });

  it('refuses agent-user as a subject, even to name it', async () => {
    expect((await get('?about=agent-user/a1/u1')).status).toBe(404);
  });

  it('refuses a bad limit, cursor or unknown subject', async () => {
    expect((await get('?limit=abc')).status).toBe(400);
    expect((await get('?cursor=nope')).status).toBe(400);
    expect((await get('?about=nonsense')).status).toBe(404);
  });

  it('parses subject keys', () => {
    expect(parseSubject('customer/acme')).toEqual({ subjectType: 'entity', subjectId: 'customer/acme' });
    expect(parseSubject('entity/customer/acme')).toEqual({ subjectType: 'entity', subjectId: 'customer/acme' });
    expect(parseSubject('workflow/wf_1')).toEqual({ subjectType: 'workflow', subjectId: 'wf_1' });
    expect(parseSubject('agent-user/x')).toBeUndefined();
    expect(parseSubject('acme')).toBeUndefined();
  });
});

describe('paging (AS-4)', () => {
  it('pages 1,200 facts 500 at a time with no overlap', async () => {
    clear();
    const db = database();
    db.transaction(() => {
      for (let i = 0; i < 1200; i++) facts.upsertFact({ id: `bulk:${i}`, subjectType: 'workflow', subjectId: 'wf_bulk', kind: 'health', statement: `Fact ${i}`, confidence: 0.5, evidence: [] } as never, db, at(i % 50) );
    });
    const seen = new Set<string>();
    let cursor: string | undefined;
    const sizes: number[] = [];
    for (let guard = 0; guard < 5; guard++) {
      const { body } = await get(`?limit=500${cursor ? `&cursor=${cursor}` : ''}`);
      const page = body.nodes.filter((n) => n.kind === 'fact');
      sizes.push(page.length);
      for (const n of page) {
        expect(seen.has(n.id)).toBe(false);
        seen.add(n.id);
      }
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(sizes).toEqual([500, 500, 200]);
    expect(seen.size).toBe(1200);
  });
});
