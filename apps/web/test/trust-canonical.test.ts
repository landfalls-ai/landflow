/**
 * C27 content-keyed trust: the canonical form (key order and tool order never matter, any change of a description, schema or
 * annotation does), the pure change list, and the trust store (one pending row per hash, approve makes a record current and is
 * audited without the snapshot body, reject and revoke are audited), on SQLite and on a Postgres-mode Database over a fake sink.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { toolChanges } from '@/lib/shared/trust';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-trust-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' });

const { canonicalJson, snapshotOf, toolFingerprint, toolsHash } = await import('@/lib/server/trust/canonical');
const trust = await import('@/lib/server/trust/store');
const { queryEvents } = await import('@/lib/server/audit/store');
const { Database, migrateSqlite } = await import('@/lib/server/db/database');
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

afterAll(() => {
  process.env = previousEnv;
});

const search = { name: 'search', description: 'Search the tracker', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } };
const create = { name: 'create', description: 'Create an issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } };
const actor = { id: 'user-1', role: 'owner' as const };
const eventsOf = (action: string) => queryEvents({ action: [action] }).events;

describe('the canonical form', () => {
  it('ignores key order at every depth and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: undefined } })).toBe('{"a":{"d":[{"x":2,"y":1}]},"b":1}');
    expect(toolFingerprint({ name: 'x', inputSchema: { b: 1, a: 2 } })).toBe(toolFingerprint({ inputSchema: { a: 2, b: 1 }, name: 'x' }));
  });
  it('hashes a reordered tool list the same (AS-5) and a changed one differently', () => {
    expect(toolsHash([search, create])).toBe(toolsHash([create, search]));
    expect(toolsHash([search, create])).not.toBe(toolsHash([{ ...search, description: 'Search everything' }, create]));
  });
  it('changes the fingerprint for a description, a schema and an annotation (read-only to destructive)', () => {
    const base = toolFingerprint(search);
    expect(toolFingerprint({ ...search, description: 'Other' })).not.toBe(base);
    expect(toolFingerprint({ ...search, inputSchema: { type: 'object', properties: { q: { type: 'number' } } } })).not.toBe(base);
    expect(toolFingerprint({ ...search, annotations: { readOnlyHint: false, destructiveHint: true } })).not.toBe(base);
  });
  it('lists changed and added tools, never removed ones, whatever the order', () => {
    const changes = toolChanges([search, create], [{ name: 'extra', description: 'New' }, { ...create }, { ...search, description: 'D2' }]);
    expect(changes.map((c) => [c.name, c.change])).toEqual([['extra', 'added'], ['search', 'changed']]);
    expect(changes[1].fields).toEqual(['description']);
    expect(toolChanges([search, create], [create]).length).toBe(0);
    expect(toolChanges([search], [search, create], false).length).toBe(0);
  });
});

describe('exports', () => {
  it('leave the switch out: an installed agent starts with it on', async () => {
    const { portableConfig } = await import('@/lib/server/marketplace/export');
    const { agentStore } = await import('@/lib/server/agents/store');
    const agent = agentStore.create({ name: 'Exported' });
    expect(agent.holdChangedTools).toBe(true);
    expect('holdChangedTools' in portableConfig(agent)).toBe(false);
  });
});

describe('the trust store on SQLite', () => {
  const subject = 'agent:ag_1/tool_1';
  const snapshot = snapshotOf([search, create]);
  it('writes a pending record once per hash', () => {
    expect(trust.recordPending('mcp-tools', subject, 'h-new', snapshot, 'search changed')).toBe(true);
    expect(trust.recordPending('mcp-tools', subject, 'h-new', snapshot, 'changed again')).toBe(false);
    const [row] = trust.pendingFor('mcp-tools', 'agent:ag_1/');
    expect(row).toMatchObject({ hash: 'h-new', state: 'pending', summary: 'search changed' });
  });
  it('approve makes the record current and audits subject, hash and summary, never the snapshot', () => {
    trust.approve(actor, 'mcp-tools', subject, 'h-old', snapshot, 'published');
    expect(trust.currentApproval('mcp-tools', subject)?.hash).toBe('h-old');
    expect(trust.isApproved('mcp-tools', subject, 'h-old')).toBe(true);
    expect(trust.isApproved('mcp-tools', subject, 'h-new')).toBe(false);
    trust.approve(actor, 'mcp-tools', subject, 'h-new', snapshot, 'search changed');
    expect(trust.currentApproval('mcp-tools', subject)?.hash).toBe('h-new');
    expect(trust.pendingFor('mcp-tools', 'agent:ag_1/')).toHaveLength(0);
    const events = eventsOf('trust.approve');
    expect(events).toHaveLength(2);
    expect(events[0].details).toMatchObject({ subject, hash: 'h-new', summary: 'search changed' });
    expect(JSON.stringify(events)).not.toContain('Search the tracker');
    expect(events[0].actor?.id).toBeDefined();
  });
  it('reject and revokeSubject are audited and revoke ends the current approval', () => {
    trust.recordPending('mcp-tools', 'agent:ag_2/t', 'h-x', snapshot, 'x');
    trust.reject(actor, 'mcp-tools', 'agent:ag_2/t', 'h-x');
    expect(trust.pendingFor('mcp-tools', 'agent:ag_2/')).toHaveLength(0);
    expect(eventsOf('trust.reject')).toHaveLength(1);
    expect(trust.revokeSubject(actor, 'mcp-tools', 'agent:ag_1/')).toBeGreaterThan(0);
    expect(trust.currentApproval('mcp-tools', subject)).toBeUndefined();
    expect(eventsOf('trust.revoke')).toHaveLength(1);
  });
});

describe('the trust store: a hash seen again is held again (review fix 2, 3, 6)', () => {
  const sub = 'agent:ag_flap/tool_1';
  const snap = snapshotOf([search]);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  it('a superseded (flapped) hash that the server serves again is pending again, with a fresh first-seen time', async () => {
    trust.recordPending('mcp-tools', sub, 'hx', snap, 'x');
    const first = trust.recordOf('mcp-tools', sub, 'hx')!.firstSeenAt;
    trust.supersedePending('mcp-tools', sub);
    expect(trust.recordOf('mcp-tools', sub, 'hx')?.state).toBe('revoked');
    await sleep(5);
    expect(trust.recordPending('mcp-tools', sub, 'hx', snap, 'x again')).toBe(true);
    const again = trust.recordOf('mcp-tools', sub, 'hx')!;
    expect(again.state).toBe('pending');
    expect(again.firstSeenAt > first).toBe(true);
  });
  it('an older approved hash that the server rolls back to is pending again', () => {
    trust.approve(actor, 'mcp-tools', 'agent:ag_roll/t', 'ha', snap, 'a');
    trust.approve(actor, 'mcp-tools', 'agent:ag_roll/t', 'hb', snap, 'b');
    expect(trust.recordPending('mcp-tools', 'agent:ag_roll/t', 'ha', snap, 'rolled back')).toBe(true);
    expect(trust.recordOf('mcp-tools', 'agent:ag_roll/t', 'ha')?.state).toBe('pending');
    expect(trust.currentApproval('mcp-tools', 'agent:ag_roll/t')?.hash).toBe('hb');
  });
  it('a rejected hash stays rejected', () => {
    trust.recordPending('mcp-tools', 'agent:ag_rej/t', 'hr', snap, 'r');
    trust.reject(actor, 'mcp-tools', 'agent:ag_rej/t', 'hr');
    expect(trust.recordPending('mcp-tools', 'agent:ag_rej/t', 'hr', snap, 'r')).toBe(false);
    expect(trust.recordOf('mcp-tools', 'agent:ag_rej/t', 'hr')?.state).toBe('rejected');
  });
  it('a new pending hash supersedes the subject\'s older pending ones: one is waiting at a time', () => {
    for (const h of ['h1', 'h2', 'h3']) trust.recordPending('mcp-tools', 'agent:ag_many/t', h, snap, h);
    expect(trust.pendingFor('mcp-tools', 'agent:ag_many/').map((r) => r.hash)).toEqual(['h3']);
    expect(trust.pendingSubjects('mcp-tools', 'agent:ag_many/')).toEqual(['agent:ag_many/t']);
  });
  it('a first-seen approval has no decider and says so', () => {
    const record = trust.approveFirstSeen('mcp-tools', 'agent:ag_first/t', 'hf', snap, 'first seen at run');
    expect(record.decidedBy).toBeUndefined();
    expect(trust.currentApproval('mcp-tools', 'agent:ag_first/t')).toMatchObject({ summary: 'first seen at run' });
    expect(trust.currentApproval('mcp-tools', 'agent:ag_first/t')?.decidedBy).toBeUndefined();
  });
});

describe('the trust store over a Postgres-mode database', () => {
  it('queues the rows through the write sink', () => {
    const queued: Array<{ op: string; table: string }> = [];
    const sqlite = new DatabaseSync(':memory:');
    migrateSqlite(sqlite);
    const handle = new Database(sqlite, 'postgres', ':memory:', { enqueue: (ops) => void queued.push(...ops), flush: async () => {}, close: async () => {}, direct: async () => undefined as never });
    expect(trust.recordPending('mcp-tools', 's', 'h1', { tools: [] }, 'x', handle)).toBe(true);
    expect(trust.recordPending('mcp-tools', 's', 'h1', { tools: [] }, 'x', handle)).toBe(false);
    expect(queued.filter((q) => q.table === 'trust_records')).toHaveLength(1);
    expect(trust.pendingFor('mcp-tools', 's', handle)).toHaveLength(1);
  });
});
