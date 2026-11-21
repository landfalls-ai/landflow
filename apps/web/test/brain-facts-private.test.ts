/**
 * C07: private fact subjects, project filters, keyset pages and scored search (docs/second-brain.md#memory-backend).
 * Written test first, one `describe` per task.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-brain-facts-private-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { database } = await import('@/lib/server/db');
const facts = await import('@/lib/server/brain/facts');
const { fuseScores } = await import('@/lib/server/notebook/search');

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const at = (n: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, 0) + n * 1000).toISOString();
const put = (id: string, subjectType: string, subjectId: string, statement: string, projectId: string | undefined, n: number, kind = 'memory') =>
  facts.upsertFact({ id, subjectType, subjectId, kind, statement, confidence: 1, evidence: [], ...(projectId && { projectId }) } as never, database(), at(n));

describe('T-3 private subjects', () => {
  beforeAll(() => {
    put('agent-user:a1/u1:memory:m1', 'agent-user', 'a1/u1', 'Prefers short answers', undefined, 1);
    put('workflow:w1:health', 'workflow', 'w1', 'Healthy', 'p1', 2, 'health');
  });

  it('leaves an agent-user fact out of every brain read', () => {
    expect(facts.listFacts().map((f) => f.id)).toEqual(['workflow:w1:health']);
    expect(facts.searchFacts('answers').map((f) => f.id)).toEqual([]);
    expect(facts.countFacts().facts).toBe(1);
    expect(facts.pageFacts({}, { limit: 10 }).facts.map((f) => f.id)).toEqual(['workflow:w1:health']);
  });

  it('lists it only when the filter names the subject type and id', () => {
    expect(facts.listFacts({ subjectType: 'agent-user', subjectId: 'a1/u1' }).map((f) => f.id)).toEqual(['agent-user:a1/u1:memory:m1']);
    // A type alone must not enumerate every person's memories.
    expect(facts.listFacts({ subjectType: 'agent-user' })).toEqual([]);
  });
});

describe('T-3 project filter and pages', () => {
  beforeAll(() => {
    for (let i = 0; i < 1200; i++) put(`project:pp:memory:m${String(i).padStart(4, '0')}`, 'project', 'pp', `Memory number ${i}`, 'pp', 100 + (i % 7));
    put('workflow:wa:health', 'workflow', 'wa', 'A is fine', 'pq', 5, 'health');
    put('workflow:wb:health', 'workflow', 'wb', 'B is fine', 'pq', 6, 'health');
    put('workflow:wc:health', 'workflow', 'wc', 'C is fine', 'pq', 7, 'health');
  });

  it('filters by project in one query with a LIMIT', () => {
    const db = database();
    const spy = vi.spyOn(db, 'all');
    const got = facts.listFacts({ projectId: 'pq' }, db);
    expect(got.map((f) => f.id).sort()).toEqual(['workflow:wa:health', 'workflow:wb:health', 'workflow:wc:health']);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toMatch(/project_id = \?/);
    expect(String(spy.mock.calls[0][0])).toMatch(/LIMIT/);
    spy.mockRestore();
  });

  it('pages 1,200 facts as 500, 500, 200 without overlap', () => {
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | undefined;
    do {
      const page = facts.pageFacts({ projectId: 'pp' }, { limit: 500, cursor });
      sizes.push(page.facts.length);
      seen.push(...page.facts.map((f) => f.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(sizes).toEqual([500, 500, 200]);
    expect(new Set(seen).size).toBe(1200);
  });

  it('puts the scope in the SQL: a page is full of visible facts', () => {
    const scope = { workflows: new Set(['wa', 'wc']), agents: new Set<string>(), entities: new Set<string>() };
    const page = facts.pageFacts({ projectId: 'pq', scope }, { limit: 2 });
    expect(page.facts.map((f) => f.subjectId).sort()).toEqual(['wa', 'wc']);
    expect(page.nextCursor).toBeUndefined();
    const one = facts.pageFacts({ projectId: 'pq', scope }, { limit: 1 });
    expect(one.facts).toHaveLength(1);
    expect(one.nextCursor).toBeDefined();
  });
});

describe('T-3 scored search', () => {
  beforeAll(() => {
    put('project:ps:memory:k1', 'project', 'ps', 'Deploys go out on Tuesday mornings', 'ps', 10);
    put('project:ps:memory:k2', 'project', 'ps', 'Tuesday is also the retro day', 'ps', 11);
    put('project:ps:memory:k3', 'project', 'ps', 'The team likes concise reports', 'ps', 12);
  });
  const base = { filter: { projectId: 'ps' }, limit: 10, threshold: 0 };

  it('scores keyword hits in 0..1, best first', () => {
    const r = facts.scoredFactSearch('deploys tuesday', { ...base, mode: 'keyword' });
    expect(r.hits.map((h) => h.fact.id)).toEqual(['project:ps:memory:k1', 'project:ps:memory:k2']);
    for (const h of r.hits) expect(h.score).toBeGreaterThan(0), expect(h.score).toBeLessThanOrEqual(1);
    expect(r.via).toBe('keywords');
  });

  it('drops hits under the threshold and reports them', () => {
    const r = facts.scoredFactSearch('deploys tuesday', { ...base, mode: 'keyword', threshold: 0.9 });
    expect(r.hits.map((h) => h.fact.id)).toEqual(['project:ps:memory:k1']);
    expect(r.dropped.count).toBe(1);
    expect(r.dropped.best).toBeGreaterThan(0);
  });

  it('hybrid with a vector list fuses meaning and words', () => {
    const r = facts.scoredFactSearch('reports', { ...base, mode: 'hybrid', vector: [{ factId: 'project:ps:memory:k3', similarity: 0.8 }, { factId: 'project:ps:memory:k1', similarity: 0.1 }] });
    expect(r.hits[0].fact.id).toBe('project:ps:memory:k3');
    expect(r.hits[0].score).toBeCloseTo(fuseScores(0.8, 1), 5);
    expect(r.via).toBe('meaning');
    expect(r.hits.map((h) => h.fact.id)).not.toContain('project:ps:memory:k1'); // 0.1 meaning, no shared word
  });

  it('an empty query lists the newest, unscored', () => {
    const r = facts.scoredFactSearch('', { ...base, mode: 'hybrid' });
    expect(r.hits.map((h) => h.fact.id)[0]).toBe('project:ps:memory:k3');
    expect(r.hits[0].score).toBe(0);
  });
});

describe('T-3 fuseScores', () => {
  it('keeps the notebook rule', () => {
    expect(fuseScores(0.3, 0)).toBe(0);
    expect(fuseScores(0.5, 0)).toBe(0.5);
    expect(fuseScores(undefined, 0.5)).toBeCloseTo(0.4, 5);
    expect(fuseScores(0.3, 0.5)).toBeCloseTo(Math.min(1, 0.4 + 0.05), 5);
  });
});
