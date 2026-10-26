/**
 * The audit log per project and its hash chain (lib/server/audit/chain.ts, ./project, ./access): every event chained
 * as it is stored (sequence, previous hash, own hash over the canonical stored fields), `verifyChain` on a clean
 * chain, an edited row, a deleted row in the middle, the newest rows deleted and a row slipped in behind Landflow's
 * back; retention pruning from the oldest end with the anchor (still verifies); several processes writing one SQLite
 * file at once (real child processes, BEGIN IMMEDIATE); GET /api/audit/verify (admins, audited); the project of an
 * event's target (workflow, credential, data table, agent, project, execution), filtering by it, and project admins
 * reading and exporting their projects' events only. Postgres in queue mode: audit-chain.postgres.test.ts.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuditChainReport, AuditEvent, AuditPage } from '@/lib/shared/audit';

vi.setConfig({ testTimeout: 60_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-audit-chain-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { database } = await import('@/lib/server/db');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { createApiKey } = await import('@/lib/server/auth/api-keys');
const audit = await import('@/lib/server/audit');
const { queryEvents, pruneEvents } = await import('@/lib/server/audit/store');
const chain = await import('@/lib/server/audit/chain');
const { targetProject } = await import('@/lib/server/audit/project');
const projects = await import('@/lib/server/projects');
const { personalProjectId } = await import('@/lib/shared/projects');
const auditRoute = await import('@/app/api/audit/route');
const exportRoute = await import('@/app/api/audit/export/route');
const verifyRoute = await import('@/app/api/audit/verify/route');

const req = (url: string, headers: Record<string, string> = {}) => new Request(`http://audit.test${url}`, { headers: { 'user-agent': 'audit-chain-test/1', ...headers } });
const db = () => database();
/** Change the stored rows behind Landflow's back (no write log, no chain). */
const raw = (sql: string, ...params: Array<string | number | null>) => db().sqlite.prepare(sql).run(...params);
const verify = () => chain.verifyChain(db());
const record = (n: number, prefix: string) => Array.from({ length: n }, (_v, i) => audit.recordAudit({ action: 'settings.update', summary: `${prefix} ${i}`, target: { type: 'settings', id: prefix } })!);

let member: Awaited<ReturnType<typeof createUser>>;
let admin: Awaited<ReturnType<typeof createUser>>;

beforeAll(async () => {
  member = await createUser({ email: 'pat@chain.test', name: 'Pat Project', role: 'member', password: 'member-password-1' });
  admin = await createUser({ email: 'ada@chain.test', name: 'Ada Admin', role: 'admin', password: 'admin-password-1' });
});

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe('the hash chain', () => {
  it('chains every event as it is stored: sequence, previous hash, SHA-256 over the stored fields', async () => {
    const events = record(5, 'clean');
    const seqs = events.map((e) => e.chain!.seq);
    expect(seqs).toEqual(seqs.map((_s, i) => seqs[0] + i));
    for (let i = 1; i < events.length; i++) expect(events[i].chain!.prevHash).toBe(events[i - 1].chain!.hash);
    const first = db().get<Record<string, unknown> & { id: string; at: string }>('SELECT * FROM audit_events WHERE chain_seq = 1')!;
    expect(first.prev_hash).toBe(chain.GENESIS);
    expect(chain.eventHash(first, 1, chain.GENESIS)).toBe(first.hash);
    // The canonical form names every stored field, the project included.
    expect(chain.CHAIN_FIELDS).toContain('project_id');
    expect(JSON.parse(chain.canonicalEvent(first, 1, chain.GENESIS))[0]).toBe('landflow.audit/1');
    // The API hands the link back too.
    const page = queryEvents({ targetId: 'clean' }, { limit: 1 });
    expect(page.events[0].chain).toEqual(events.at(-1)!.chain);

    const report = await verify();
    expect(report).toMatchObject({ ok: true, problems: [], firstSeq: 1, pending: 0, legacy: 0 });
    expect(report.checked).toBe(report.lastSeq);
    expect(report.head).toMatchObject({ seq: report.lastSeq, hash: events.at(-1)!.chain!.hash });
  });

  it('breaks at an edited row (and verifies again once it is put back)', async () => {
    const [, target] = record(3, 'edit');
    const seq = target.chain!.seq;
    raw('UPDATE audit_events SET summary = ? WHERE chain_seq = ?', 'nothing to see here', seq);
    const report = await verify();
    expect(report.ok).toBe(false);
    expect(report.brokenAt).toMatchObject({ seq, eventId: target.id, reason: 'The event was changed after it was recorded' });
    // A changed project is a change too.
    raw('UPDATE audit_events SET summary = ?, project_id = ? WHERE chain_seq = ?', target.summary, 'prj_moved', seq);
    expect((await verify()).brokenAt).toMatchObject({ seq, reason: 'The event was changed after it was recorded' });
    raw('UPDATE audit_events SET project_id = NULL WHERE chain_seq = ?', seq);
    expect((await verify()).ok).toBe(true);
  });

  it('breaks at a recomputed row too: its successor’s link no longer matches', async () => {
    const [, target] = record(3, 'rehash');
    const seq = target.chain!.seq;
    const row = db().get<Record<string, unknown> & { id: string; at: string; prev_hash: string; hash: string }>('SELECT * FROM audit_events WHERE chain_seq = ?', seq)!;
    // Someone who knows the scheme rewrites the event and its hash: the next event still points at the old hash.
    const forged = { ...row, summary: 'forged' };
    raw('UPDATE audit_events SET summary = ?, hash = ? WHERE chain_seq = ?', 'forged', chain.eventHash(forged, seq, row.prev_hash), seq);
    expect((await verify()).brokenAt).toMatchObject({ seq: seq + 1, reason: 'Its link to the previous event doesn’t match: the event before it was changed or replaced' });
    raw('UPDATE audit_events SET summary = ?, hash = ? WHERE chain_seq = ?', String(row.summary), row.hash, seq);
    expect((await verify()).ok).toBe(true);
  });

  it('breaks at a deleted row in the middle', async () => {
    const [, gone] = record(3, 'delete');
    const saved = db().get<Record<string, string | number | null>>('SELECT * FROM audit_events WHERE id = ?', gone.id)!;
    raw('DELETE FROM audit_events WHERE id = ?', gone.id);
    const report = await verify();
    expect(report.ok).toBe(false);
    expect(report.brokenAt).toMatchObject({ seq: gone.chain!.seq, reason: `Event #${gone.chain!.seq} is missing: it was deleted` });
    const columns = Object.keys(saved);
    raw(`INSERT INTO audit_events (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, ...columns.map((c) => saved[c]));
    expect((await verify()).ok).toBe(true);
  });

  it('shows the newest events deleted (the head record remembers them)', async () => {
    const events = record(2, 'newest');
    const saved = db().all<Record<string, string | number | null>>('SELECT * FROM audit_events WHERE target_id = ? ORDER BY chain_seq', 'newest');
    raw('DELETE FROM audit_events WHERE target_id = ?', 'newest');
    const report = await verify();
    expect(report.ok).toBe(false);
    expect(report.brokenAt?.reason).toBe(`The newest 2 events (#${events[0].chain!.seq}–#${events[1].chain!.seq}) are missing: they were deleted`);
    for (const row of saved) {
      const columns = Object.keys(row);
      raw(`INSERT INTO audit_events (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, ...columns.map((c) => row[c]));
    }
    expect((await verify()).ok).toBe(true);
  });

  it('flags an event slipped in without a link', async () => {
    raw(`INSERT INTO audit_events (id, at, action, category, outcome, actor_type, summary) VALUES ('aud_slipped', ?, 'settings.update', 'settings', 'success', 'system', 'slipped in')`, new Date().toISOString());
    const report = await verify();
    expect(report.ok).toBe(false);
    expect(report.problems).toContainEqual(expect.objectContaining({ eventId: 'aud_slipped', reason: 'The event isn’t chained: it was added outside Landflow' }));
    raw(`DELETE FROM audit_events WHERE id = 'aud_slipped'`);
    expect((await verify()).ok).toBe(true);
  });

  it('prunes from the oldest end and keeps verifying from the anchor', async () => {
    const before = await verify();
    const later = Date.now() + 2 * 86_400_000;
    // Everything stored so far is older than a day "two days from now"; a fresh event isn't (relative to that now).
    const fresh = audit.recordAudit({ action: 'settings.update', summary: 'fresh', at: new Date(later) })!;
    const removed = pruneEvents(1, later);
    expect(removed).toBe(before.checked);
    const report = await verify();
    expect(report).toMatchObject({ ok: true, checked: 1, firstSeq: fresh.chain!.seq, lastSeq: fresh.chain!.seq });
    expect(report.anchor).toMatchObject({ seq: fresh.chain!.seq - 1 });
    expect(fresh.chain!.prevHash).toBe(report.anchor!.hash);
    // New events chain on; deleting the anchor shows (the chain no longer starts where it says).
    record(2, 'after-prune');
    expect((await verify()).ok).toBe(true);
    const anchor = db().get<Record<string, string | number | null>>(`SELECT * FROM audit_chain WHERE id = 'anchor'`)!;
    raw(`DELETE FROM audit_chain WHERE id = 'anchor'`);
    expect((await verify()).brokenAt?.reason).toMatch(/^Events #1–#\d+ are missing: they were deleted$/);
    raw('INSERT INTO audit_chain (id, seq, hash, event_id, at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', anchor.id, anchor.seq, anchor.hash, anchor.event_id, anchor.at, anchor.updated_at);
    expect((await verify()).ok).toBe(true);
    // Nothing to prune: the anchor stays.
    expect(pruneEvents(365)).toBe(0);
    expect((await verify()).anchor).toEqual(report.anchor);
  });

  it('several processes writing one SQLite file at once take turns on the chain', async () => {
    const before = await verify();
    const script = join(mkdtempSync(join(tmpdir(), 'landflow-audit-writer-')), 'writer.ts');
    const src = resolve(__dirname, '..', 'src', 'lib', 'server');
    writeFileSync(
      script,
      `import { openSqlite } from ${JSON.stringify(join(src, 'db', 'database.ts'))};
import { insertEvent } from ${JSON.stringify(join(src, 'audit', 'store.ts'))};
const [file, name, count] = process.argv.slice(2);
const db = openSqlite(file);
for (let i = 0; i < Number(count); i++) {
  insertEvent({ id: 'aud_' + name + '_' + i, at: new Date().toISOString(), action: 'settings.update', category: 'settings', outcome: 'success', actor: { type: 'system' }, target: { type: 'settings', id: 'writers' }, summary: name + ' ' + i }, db);
}
db.sqlite.close();
`,
    );
    const tsx = resolve(__dirname, '..', 'node_modules', '.bin', 'tsx');
    const run = promisify(execFile);
    const file = join(dataDir, 'landflow.db');
    await Promise.all(['a', 'b', 'c'].map((name) => run(tsx, [script, file, name, '40'], { env: { ...process.env, LANDFLOW_DATA_DIR: dataDir } })));
    const report = await verify();
    expect(report.problems).toEqual([]);
    expect(report.checked).toBe(before.checked + 120);
    const rows = db().all<{ id: string; chain_seq: number }>(`SELECT id, chain_seq FROM audit_events WHERE target_id = 'writers' ORDER BY chain_seq`);
    expect(rows).toHaveLength(120);
    expect(new Set(rows.map((r) => r.chain_seq)).size).toBe(120);
    // The three really interleaved (the chain is one sequence across them).
    expect(new Set(rows.slice(0, 60).map((r) => r.id.split('_')[1])).size).toBeGreaterThan(1);
  });
});

describe('GET /api/audit/verify', () => {
  it('answers the report and audits the check (a failure when broken); owners and admins only', async () => {
    enableTestAuth();
    const response = await verifyRoute.GET(req('/api/audit/verify'));
    expect(response.status).toBe(200);
    const report = (await response.json()) as AuditChainReport;
    expect(report.ok).toBe(true);
    expect(queryEvents({ action: ['audit.verify'] }, { limit: 1 }).events[0]).toMatchObject({ outcome: 'success', details: { ok: true, checked: report.checked } });

    const victim = record(1, 'route-break')[0];
    raw('UPDATE audit_events SET summary = ? WHERE id = ?', 'changed', victim.id);
    const broken = (await (await verifyRoute.GET(req('/api/audit/verify'))).json()) as AuditChainReport;
    expect(broken).toMatchObject({ ok: false, brokenAt: { seq: victim.chain!.seq, eventId: victim.id } });
    expect(queryEvents({ action: ['audit.verify'] }, { limit: 1 }).events[0]).toMatchObject({ outcome: 'failure', details: { ok: false, brokenAtSeq: victim.chain!.seq } });
    raw('UPDATE audit_events SET summary = ? WHERE id = ?', victim.summary, victim.id);

    enableTestAuth(member);
    try {
      expect((await verifyRoute.GET(req('/api/audit/verify'))).status).toBe(403);
    } finally {
      enableTestAuth();
    }
    const withScope = createApiKey(admin, { label: 'audit', scopes: ['audit:read'] });
    const without = createApiKey(admin, { label: 'read', scopes: ['workflows:read'] });
    expect((await verifyRoute.GET(req('/api/audit/verify', { authorization: `Bearer ${withScope.token}` }))).status).toBe(200);
    expect((await verifyRoute.GET(req('/api/audit/verify', { authorization: `Bearer ${without.token}` }))).status).toBe(403);
  });
});

describe('events per project', () => {
  let team: { id: string };
  let other: { id: string };

  beforeAll(() => {
    team = projects.createTeamProject({ name: 'TMP Chain team' });
    other = projects.createTeamProject({ name: 'TMP Chain other' });
    projects.setMember(team.id, member.id, 'admin');
    projects.setMember(other.id, member.id, 'editor');
  });

  it('records the project of the target: a resource’s home project, a project itself, an execution’s workflow’s', () => {
    projects.setHomeProject('workflow', 'wf_team', team.id);
    projects.setHomeProject('credential', 'cred_team', team.id);
    projects.setHomeProject('dataTable', 'dt_team', team.id);
    projects.setHomeProject('agent', 'agt_other', other.id);
    expect(targetProject({ type: 'workflow', id: 'wf_team' })).toBe(team.id);
    expect(targetProject({ type: 'credential', id: 'cred_team' })).toBe(team.id);
    expect(targetProject({ type: 'data_table', id: 'dt_team' })).toBe(team.id);
    expect(targetProject({ type: 'agent', id: 'agt_other' })).toBe(other.id);
    expect(targetProject({ type: 'execution', id: 'exe_x' }, { workflowId: 'wf_team' })).toBe(team.id);
    expect(targetProject({ type: 'project', id: team.id })).toBe(team.id);
    expect(targetProject({ type: 'user', id: member.id })).toBeUndefined();
    expect(targetProject({ type: 'settings', id: 'general' })).toBeUndefined();
    // A resource with no stored home belongs to the default project.
    expect(targetProject({ type: 'workflow', id: 'wf_unknown' })).toBe(projects.defaultProjectId());
    expect(targetProject({ type: 'execution', id: 'exe_x' }, { workflowId: 'wf_unknown' })).toBe(projects.defaultProjectId());
    // Found from the target when the event doesn't say.
    const found = audit.recordAudit({ action: 'workflow.update', target: { type: 'workflow', id: 'wf_team', name: 'Team flow' } })!;
    expect(found.projectId).toBe(team.id);
    const explicit = audit.recordAudit({ action: 'workflow.update', target: { type: 'workflow', id: 'wf_gone', name: 'Deleted flow' }, project: team.id })!;
    expect(explicit.projectId).toBe(team.id);
    const ofProject = audit.recordAudit({ action: 'settings.update', target: { type: 'project', id: other.id, name: 'Other' } })!;
    expect(ofProject.projectId).toBe(other.id);
    const instance = audit.recordAudit({ action: 'settings.update', target: { type: 'settings', id: 'general' } })!;
    expect(instance.projectId).toBeUndefined();
  });

  it('filters by project; project admins read and export only their projects’ events', async () => {
    audit.recordAudit({ action: 'credential.update', target: { type: 'credential', id: 'cred_team', name: 'Team key' }, project: team.id });
    audit.recordAudit({ action: 'credential.update', target: { type: 'credential', id: 'cred_other', name: 'Other key' }, project: other.id });
    audit.recordAudit({ action: 'data_table.update', target: { type: 'data_table', id: 'dt_mine', name: 'Mine' }, project: personalProjectId(member.id) });
    const ids = (page: AuditPage) => page.events.map((e: AuditEvent) => e.target?.id);

    expect(ids(queryEvents({ projectId: team.id }, { limit: 50 }))).toEqual(expect.arrayContaining(['cred_team', 'wf_team']));
    expect(ids(queryEvents({ projectId: team.id }, { limit: 50 }))).not.toContain('cred_other');
    // The owner (test bypass) reads any project's.
    const all = (await (await auditRoute.GET(req(`/api/audit?projectId=${other.id}`))).json()) as AuditPage;
    expect(ids(all)).toContain('cred_other');

    enableTestAuth(member);
    try {
      // Admin of the team project and of their personal one; only an editor of the other.
      const mine = (await (await auditRoute.GET(req('/api/audit?limit=500'))).json()) as AuditPage;
      expect(ids(mine)).toEqual(expect.arrayContaining(['cred_team', 'dt_mine']));
      expect(ids(mine)).not.toContain('cred_other');
      expect(mine.events.every((e) => e.projectId === team.id || e.projectId === personalProjectId(member.id))).toBe(true);
      expect((await auditRoute.GET(req(`/api/audit?projectId=${team.id}`))).status).toBe(200);
      const refused = await auditRoute.GET(req(`/api/audit?projectId=${other.id}`));
      expect(refused.status).toBe(403);
      expect((await refused.json()).error).toMatch(/Only admins of this project/);

      const csv = await exportRoute.GET(req(`/api/audit/export?projectId=${team.id}&format=csv`));
      expect(csv.status).toBe(200);
      const lines = (await csv.text()).trim().split('\r\n');
      expect(lines[0].split(',')).toEqual(expect.arrayContaining(['project_id', 'chain_seq', 'prev_hash', 'hash']));
      expect(lines.slice(1).every((line) => line.includes(team.id))).toBe(true);
      expect((await exportRoute.GET(req(`/api/audit/export?projectId=${other.id}`))).status).toBe(403);
      const json = (await (await exportRoute.GET(req('/api/audit/export?format=json'))).json()) as AuditEvent[];
      expect(json.map((e) => e.target?.id)).not.toContain('cred_other');
    } finally {
      enableTestAuth();
    }
  });
});
