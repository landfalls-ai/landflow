/**
 * Regular Postgres, one host and no replica (wave ap1 fix pass): `claim` and `recordNudge` finish out of order in one process.
 * The copy that follows Postgres (`adopt`) took the whole row a task read, so a nudge that read `waiting` and finished after a
 * claim wrote `waiting` over `approved` in the copy and queued that full row, which reached Postgres last. A fake Postgres
 * (a map behind `direct`, a queue behind the sink) takes the Database through its real postgres-mode paths with no server.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DirectClient, WriteOp, WriteSink } from '@/lib/server/db/database';

vi.setConfig({ testTimeout: 20_000 });

const { Database, migrateSqlite } = await import('@/lib/server/db/database');
const { claim, recordNudge } = await import('@/lib/server/approval-inbox/store');

type Row = Record<string, unknown>;
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

function fakePostgres() {
  const remote = new Map<string, Row>();
  const queued: WriteOp[] = [];
  const gates: { nudgeApplied?: () => void; holdNudge?: Promise<void> } = {};
  const applyQueued = () => {
    for (const op of queued.splice(0)) if (op.op === 'upsert' && op.table === 'approval_inbox') remote.set(String(op.row.id), { ...remote.get(String(op.row.id)), ...op.row });
  };
  const client: DirectClient = {
    async query(text: string, values: unknown[] = []) {
      if (text.startsWith('UPDATE approval_inbox SET status')) {
        const [to, by, byName, via, at, id] = values as string[];
        const row = remote.get(id);
        if (!row || row.status !== 'waiting') return { rows: [], rowCount: 0 };
        const next = { ...row, status: to, decided_by: by, decided_by_name: byName, decided_via: via, decided_at: at };
        remote.set(id, next);
        return { rows: [{ ...next }] as never[], rowCount: 1 };
      }
      if (text.startsWith('UPDATE approval_inbox SET nudged')) {
        const [nudged, id, was] = values as [string, string, string | null];
        const row = remote.get(id);
        if (!row || (row.nudged ?? null) !== (was ?? null)) return { rows: [], rowCount: 0 };
        const next = { ...row, nudged };
        remote.set(id, next);
        gates.nudgeApplied?.();
        await gates.holdNudge; // the answer is on its way back to this process
        return { rows: [{ ...next }] as never[], rowCount: 1 };
      }
      if (text.startsWith('SELECT * FROM approval_inbox')) {
        const row = remote.get(String(values[0]));
        return { rows: row ? [{ ...row }] as never[] : [], rowCount: row ? 1 : 0 };
      }
      throw new Error(`fake postgres: unexpected query ${text}`);
    },
  };
  const sink: WriteSink = {
    enqueue: (ops) => void queued.push(...ops),
    flush: async () => applyQueued(),
    close: async () => {},
    direct: (fn) => fn(client),
  };
  const sqlite = new DatabaseSync(':memory:');
  migrateSqlite(sqlite);
  const handle = new Database(sqlite, 'postgres', ':memory:', sink);
  return { handle, remote, gates, applyQueued };
}

const waiting = (id: string) => ({ id, execution_id: `exec-${id}`, call_id: 'c1', workflow_id: 'wf', workflow_name: 'Flow', workflow_version: 1, node_id: 'n', node_name: 'Ask', agent_id: 'a', agent_name: 'Mailer', agent_version: '1', session_id: 's', project_id: null, tool: 'Send Email', params: '{}', destination: null, trigger_word: 'webhook', status: 'waiting', requested_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString(), nudged: null, decided_by: null, decided_by_name: null, decided_via: null, decided_at: null });

describe('claim and nudge finishing out of order on one Postgres host', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a nudge that read `waiting` and answers after a claim never puts `waiting` back in the copy or in Postgres', async () => {
    const { handle, remote, gates, applyQueued } = fakePostgres();
    handle.upsert('approval_inbox', waiting('r1'));
    await handle.flush();
    let release!: () => void;
    gates.holdNudge = new Promise<void>((resolve) => (release = resolve));
    const applied = new Promise<void>((resolve) => (gates.nudgeApplied = resolve));

    const nudge = recordNudge('r1', { email: 1, channels: 0 }, handle);
    await applied; // the nudge's UPDATE is in Postgres, its answer (status waiting) not yet back here
    const won = await claim('r1', 'approved', { by: 'ada@x.test', byName: 'Ada', via: 'inbox' }, handle);
    expect(won.won).toBe(true);
    release();
    await nudge;
    applyQueued(); // the queued replays reach Postgres, in order

    const local = handle.get<Row>('SELECT * FROM approval_inbox WHERE id = ?', 'r1')!;
    for (const row of [local, remote.get('r1')!]) {
      expect(row.status).toBe('approved');
      expect(row.decided_by).toBe('ada@x.test');
      expect(JSON.parse(String(row.nudged)).email).toBe(1);
    }
  });

  it('and the other way round: a claim that answers after a nudge keeps the nudge counts', async () => {
    const { handle, remote, applyQueued } = fakePostgres();
    handle.upsert('approval_inbox', waiting('r2'));
    await handle.flush();
    const won = claim('r2', 'denied', { by: 'bob@x.test', via: 'inbox' }, handle);
    await recordNudge('r2', { email: 2, channels: 1 }, handle);
    await won;
    applyQueued();
    const local = handle.get<Row>('SELECT * FROM approval_inbox WHERE id = ?', 'r2')!;
    for (const row of [local, remote.get('r2')!]) {
      expect(row.status).toBe('denied');
      expect(JSON.parse(String(row.nudged))).toMatchObject({ email: 2, channels: 1 });
    }
  });
});
