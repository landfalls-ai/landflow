/**
 * Commands a Claude Code member's guard asks a person about (lib/server/a2a/agent-asks.ts, docs/a2a.md): the mod's `ask` event
 * on POST /api/agent-trace/:id, the open wait it makes in the run's journal, the polling route, the decision route and the
 * Approval check. The run is not paused: only the journal, the table and the routes are involved.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { foldJournal } from '@/lib/shared/run-trace-model';

const { openTrace, ingestTrace, resetTraces } = await import('@/lib/server/a2a/agent-trace');
const { openAsks, ASK_TTL_MS } = await import('@/lib/server/a2a/agent-asks');
const { database } = await import('@/lib/server/db');
const { journalStore, resetJournals } = await import('@/lib/server/journal');
const { needsYou } = await import('@/lib/server/journal/needs-you');
const { store } = await import('@/lib/server/store');
const { isPublicPath } = await import('@/lib/shared/auth-paths');
const { resourceRule } = await import('@/lib/server/auth/policy');
const poll = await import('@/app/api/agent-trace/[id]/asks/[askId]/route');
const decide = await import('@/app/api/executions/[id]/asks/[askId]/route');
const list = await import('@/app/api/executions/[id]/asks/route');

let n = 0;
const fresh = () => ({ executionId: `exec-asks-${process.pid}-${++n}`, workflowId: 'wf-asks' });
const ASK = { type: 'ask', askId: 'ask-1-abc', command: 'git push origin main', cwd: '/data/workspace', reason: 'Pushing to main.' };

const pollAsk = (traceId: string, askId = ASK.askId, wait = 0) =>
  poll.GET(new Request(`http://landflow.test/api/agent-trace/${traceId}/asks/${askId}?wait=${wait}`), { params: Promise.resolve({ id: traceId, askId }) });
const decideAsk = (executionId: string, askId: string, approved: boolean) =>
  decide.POST(new Request(`http://landflow.test/api/executions/${executionId}/asks/${askId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approved }) }), { params: Promise.resolve({ id: executionId, askId }) });

beforeEach(() => {
  resetTraces();
  resetJournals();
});

const journalOf = (executionId: string) => journalStore.readAll(executionId);

describe('an ask from a member in a run', () => {
  it('shows as an open wait under the member’s request, and the run is not touched', async () => {
    const run = fresh();
    const trace = openTrace({ baseUrl: 'http://landflow.test', run: { ...run, member: 'Developer', spanId: 'node:n1:0/step:c1' } });
    expect(ingestTrace(trace.id, [ASK])).toBe('ok');
    const [open] = openAsks(run.executionId);
    expect(open).toMatchObject({ member: 'Developer', command: 'git push origin main', status: 'pending', parentSpanId: 'node:n1:0/step:c1' });

    const events = journalOf(run.executionId);
    const started = events.find((e) => e.type === 'span.started');
    expect(started).toMatchObject({ kind: 'wait', parentSpanId: 'node:n1:0/step:c1', input: 'git push origin main', attrs: { wait: 'approval', ask: open.id, member: 'Developer', command: 'git push origin main' } });
    expect(started && 'name' in started && started.name).toBe('Developer wants to run git push origin main');
    // Run Trace's Needs you lists it as a wait; the cross-run list as an approval.
    const model = foldJournal(events);
    expect(model.needsYou).toEqual([expect.objectContaining({ kind: 'wait', title: 'Developer wants to run git push origin main', attrs: expect.objectContaining({ wait: 'approval', ask: open.id }) })]);
    const now = new Date().toISOString();
    store.saveExecution({ executionId: run.executionId, workflowId: run.workflowId, workflowName: 'Ship it', mode: 'manual', status: 'running', startedAt: now, finishedAt: now, durationMs: 1, runData: {}, executionOrder: [] });
    expect(needsYou(undefined).find((i) => i.executionId === run.executionId)).toMatchObject({ kind: 'approval', title: 'Developer wants to run git push origin main' });
    expect(await (await list.GET(new Request('http://landflow.test'), { params: Promise.resolve({ id: run.executionId }) })).json()).toMatchObject({ asks: [{ id: open.id }] });

    // The mod polls: pending until a person decides.
    expect(await (await pollAsk(trace.id)).json()).toEqual({ decision: 'pending' });
  });

  it('approve: the poll says approved with who and when, and the journal gets the wait’s end and an Approval check', async () => {
    const run = fresh();
    const trace = openTrace({ baseUrl: 'http://landflow.test', run: { ...run, member: 'Developer', spanId: 'req' } });
    ingestTrace(trace.id, [ASK]);
    const [{ id }] = openAsks(run.executionId);
    const response = await decideAsk(run.executionId, id, true);
    expect(response.status).toBe(200);
    const answer = await (await pollAsk(trace.id)).json();
    expect(answer).toMatchObject({ decision: 'approved' });
    expect(answer.by).toBeTruthy();
    expect(answer.at).toMatch(/^\d{4}-/);

    const events = journalOf(run.executionId);
    expect(events.find((e) => e.type === 'span.ended' && e.spanId.includes('/ask:'))).toMatchObject({ status: 'success' });
    const check = events.find((e) => e.type === 'check');
    expect(check).toMatchObject({ spanId: 'req', check: { name: 'Approval', status: 'pass', subject: 'Developer', evidence: { command: 'git push origin main', decision: 'approved' } } });
    expect(check && 'check' in check && check.check.message).toContain('approved Developer’s'.replace('’', "'"));
    expect(foldJournal(events).needsYou).toEqual([]);
    expect(openAsks(run.executionId)).toEqual([]);
    // Once is enough.
    expect((await decideAsk(run.executionId, id, false)).status).toBe(409);
  });

  it('reject: denied, and the Approval check is a warning', async () => {
    const run = fresh();
    const trace = openTrace({ baseUrl: 'http://landflow.test', run: { ...run, member: 'Developer', spanId: 'req' } });
    ingestTrace(trace.id, [ASK]);
    const [{ id }] = openAsks(run.executionId);
    await decideAsk(run.executionId, id, false);
    expect(await (await pollAsk(trace.id)).json()).toMatchObject({ decision: 'denied' });
    expect(journalOf(run.executionId).find((e) => e.type === 'check')).toMatchObject({ check: { name: 'Approval', status: 'warn', evidence: { decision: 'denied' } } });
  });

  it('a long poll returns when a person decides', async () => {
    const run = fresh();
    const trace = openTrace({ baseUrl: 'http://landflow.test', run: { ...run, spanId: 'req' } });
    ingestTrace(trace.id, [ASK]);
    const [{ id }] = openAsks(run.executionId);
    const started = Date.now();
    const waiting = pollAsk(trace.id, ASK.askId, 10);
    setTimeout(() => void decideAsk(run.executionId, id, true), 300);
    expect(await (await waiting).json()).toMatchObject({ decision: 'approved' });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('nobody answers in time: denied as expired, the wait ends, and a late decision gets 409', async () => {
    const run = fresh();
    const trace = openTrace({ baseUrl: 'http://landflow.test', run: { ...run, member: 'Developer', spanId: 'req' } });
    ingestTrace(trace.id, [ASK]);
    const [{ id }] = openAsks(run.executionId);
    const row = database().get<Record<string, unknown>>('SELECT * FROM agent_asks WHERE id = ?', id)!;
    database().upsert('agent_asks', { ...row, created_at: new Date(Date.now() - ASK_TTL_MS - 1000).toISOString() } as never);
    expect(await (await pollAsk(trace.id)).json()).toEqual({ decision: 'denied', expired: true });
    expect((await decideAsk(run.executionId, id, true)).status).toBe(409);
    const events = journalOf(run.executionId);
    expect(events.find((e) => e.type === 'span.ended' && e.spanId.includes('/ask:'))).toMatchObject({ status: 'canceled' });
    expect(events.find((e) => e.type === 'check')).toMatchObject({ check: { name: 'Approval', status: 'warn' } });
  });

  it('the call ends while it waits: the ask is closed', async () => {
    const run = fresh();
    const trace = openTrace({ baseUrl: 'http://landflow.test', run: { ...run, spanId: 'req' } });
    ingestTrace(trace.id, [ASK]);
    await trace.close(0);
    expect(await (await pollAsk(trace.id)).json()).toEqual({ decision: 'denied', expired: true });
    expect(openAsks(run.executionId)).toEqual([]);
  });
});

describe('asks that have nowhere to be shown', () => {
  it('a call outside a run is denied at once, so the mod does not wait for nobody', async () => {
    const trace = openTrace({ baseUrl: 'http://landflow.test' });
    ingestTrace(trace.id, [ASK]);
    expect(await (await pollAsk(trace.id)).json()).toMatchObject({ decision: 'denied', by: 'Landflow' });
  });

  it('a call with too many open asks is denied, and the same ask twice is one', async () => {
    const run = fresh();
    const trace = openTrace({ baseUrl: 'http://landflow.test', run: { ...run, spanId: 'req' } });
    ingestTrace(trace.id, [ASK, ASK]);
    expect(openAsks(run.executionId)).toHaveLength(1);
    for (let i = 2; i <= 6; i++) ingestTrace(trace.id, [{ ...ASK, askId: `ask-${i}` }]);
    expect(openAsks(run.executionId)).toHaveLength(5);
    expect(await (await pollAsk(trace.id, 'ask-6')).json()).toMatchObject({ decision: 'denied' });
  });

  it('an unknown ask is pending (queue mode: the post may still be on its way), and bad ids are 404', async () => {
    const trace = openTrace({ baseUrl: 'http://landflow.test' });
    expect(await (await pollAsk(trace.id, 'nothing-yet')).json()).toEqual({ decision: 'pending' });
    expect((await pollAsk('../../x', 'a')).status).toBe(404);
    expect((await decideAsk('exec-none', 'ask_nope', true)).status).toBe(404);
  });

  it('the polling route is public like the trace route, the decision route is not', () => {
    expect(isPublicPath('/api/agent-trace/abc/asks/ask-1')).toBe(true);
    expect(isPublicPath('/api/executions/e1/asks/ask_1')).toBe(false);
    // Deciding needs the access to the run that deciding its tool approvals needs; reading the list is a read.
    expect(resourceRule('POST', '/api/executions/e1/asks/ask_1')).toMatchObject({ kind: 'execution', id: 'e1', action: 'run' });
    expect(resourceRule('GET', '/api/executions/e1/asks')).toMatchObject({ kind: 'execution', action: 'read' });
  });
});
