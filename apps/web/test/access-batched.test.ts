/**
 * List paths work out access with a constant number of queries: withOwnership for 200 resources reads the shares of the
 * kind once, not once per resource, and gives the same ownership the single-resource functions do.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-access-batched-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });

const { createUser } = await import('@/lib/server/auth/users');
const projects = await import('@/lib/server/projects');
const { withOwnership, resourceAccess } = await import('@/lib/server/projects/access');
const { database } = await import('@/lib/server/db');

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

describe('batched access', () => {
  it('checks 200 resources with a constant number of queries and the same answers', async () => {
    await createUser({ name: 'Owner', email: 'owner@example.com', password: 'a-long-test-password', role: 'owner' });
    const member = await createUser({ name: 'Member', email: 'member@example.com', password: 'a-long-test-password', role: 'member' });
    const team = projects.createTeamProject({ name: 'Team' });
    const other = projects.createTeamProject({ name: 'Other' });
    projects.setMember(team.id, member.id, 'editor');

    const ids = Array.from({ length: 200 }, (_, i) => `wf-${i}`);
    ids.forEach((id, i) => {
      projects.setHomeProject('workflow', id, i % 2 ? team.id : other.id);
      if (i % 4 === 0) projects.addShare('workflow', id, team.id, 'viewer');
    });
    const items = ids.map((id) => ({ id }));
    const actor = { id: member.id, role: member.role };

    const db = database();
    const counts = (n: number) => {
      let queries = 0;
      const all = db.all.bind(db);
      const get = db.get.bind(db);
      db.all = ((...args: Parameters<typeof db.all>) => (queries++, all(...args))) as typeof db.all;
      db.get = ((...args: Parameters<typeof db.get>) => (queries++, get(...args))) as typeof db.get;
      try {
        return { result: withOwnership(actor, 'workflow', items.slice(0, n)), queries };
      } finally {
        db.all = all;
        db.get = get;
      }
    };
    counts(1); // the first call creates the member's personal project
    const small = counts(10);
    const large = counts(200);
    // The queries it makes do not grow with the list (a per-item lookup would add 400+).
    expect(large.queries).toBe(small.queries);
    expect(large.queries).toBeLessThan(20);

    // Visible: the team's own (odd) and the shared ones (every fourth, which are in `other`): odd + shared.
    expect(large.result.length).toBe(100 + 50);
    for (const item of large.result) {
      const single = resourceAccess(actor, 'workflow', item.id);
      expect(item.ownership.access).toEqual(single);
    }
  });
});
