/**
 * What a run did, in one line (lib/shared/run-line.ts, app/api/runs/lines): what came in from the trigger, who did it
 * (the team's lead and the members who worked), what came out from the artifacts, a wait or a failure; and the route
 * that reads the lines of several saved runs as the synthetic owner.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { JournalEvent, RunActor } from '@/lib/shared/run-trace';
import { foldJournal } from '@/lib/shared/run-trace-model';
import { firstJson, runLine } from '@/lib/shared/run-line';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-run-line-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { journalOf, releaseJournal, resetJournals } = await import('@/lib/server/journal');
const { store } = await import('@/lib/server/store');
const lines = await import('@/app/api/runs/lines/route');

afterAll(() => {
  resetJournals();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const flow: RunActor = { id: 'workflow', type: 'system', name: 'Tech Review Workflow' };
const trigger: RunActor = { id: 'node:trigger', type: 'system', name: 'On pull request', nodeType: 'github.trigger' };
const lead: RunActor = { id: 'node:team', type: 'agent', name: 'Tech Lead' };
const rev: RunActor = { id: 'member:rev', type: 'agent', name: 'Reviewer' };
const person: RunActor = { id: 'human:you', type: 'human', name: 'You' };
const team = { id: 't1', name: 'Tech Lead team', members: [{ id: 'l', title: 'Tech Lead', kind: 'agent' }, { id: 'r', title: 'Reviewer', kind: 'agent', reportsTo: 'l' }, { id: 'd', title: 'Developer', kind: 'agent', reportsTo: 'l' }] };

function journal(build: (add: (time: number, e: Record<string, unknown>) => void) => void): JournalEvent[] {
  let seq = 0;
  const list: JournalEvent[] = [];
  build((time, e) => list.push({ seq: ++seq, executionId: 'x1', at: at(time), ...e } as JournalEvent));
  return list;
}

const prRun = (end: (add: (time: number, e: Record<string, unknown>) => void) => void) =>
  journal((add) => {
    add(0, { type: 'span.started', spanId: 'run', kind: 'run', name: 'Tech Review Workflow', actor: flow });
    add(0, { type: 'span.started', spanId: 'node:trigger:0', parentSpanId: 'run', kind: 'step', name: 'On pull request', actor: trigger, nodeId: 'trigger' });
    add(1, { type: 'span.ended', spanId: 'node:trigger:0', status: 'success', output: [[{ json: { pull_request: { number: 5, title: 'Add the alerts plugin' } } }]] });
    add(2, { type: 'span.started', spanId: 'node:team:0', parentSpanId: 'run', kind: 'agent', name: 'Team', actor: lead, nodeId: 'team', attrs: { team } });
    add(3, { type: 'span.started', spanId: 'node:team:0/ask:1', parentSpanId: 'node:team:0', kind: 'delegate', name: 'Review #5', actor: rev, caller: lead, input: 'Review #5' });
    end(add);
  });

describe('a run in one line', () => {
  it('reads a pull request in, the team’s lead with the member who worked, and the review it posted', () => {
    const line = runLine(
      foldJournal(
        prRun((add) => {
          add(40, { type: 'artifact', spanId: 'node:team:0/ask:1', artifact: { name: '#5 · approve', kind: 'review', url: 'https://github.com/o/plugins/pull/5#review' } });
          add(41, { type: 'span.ended', spanId: 'node:team:0/ask:1', status: 'success', output: 'Approved' });
          add(50, { type: 'span.ended', spanId: 'node:team:0', status: 'success', output: { reply: 'Reviewed' } });
          add(51, { type: 'span.ended', spanId: 'run', status: 'success' });
        }),
      ),
    );
    expect(line.in).toMatchObject({ kind: 'pull_request', label: 'Pull request', detail: '#5 Add the alerts plugin' });
    expect(line.by.lead?.name).toBe('Tech Lead');
    expect(line.by.members.map((m) => m.name)).toEqual(['Reviewer']);
    expect(line.by.team).toBe('Tech Lead team');
    expect(line.out).toMatchObject({ label: 'Review posted', detail: '#5 · approve', tone: 'ok', url: 'https://github.com/o/plugins/pull/5#review' });
    expect(line.ms).toBe(51_000);
  });

  it('says a run waits for you, with what it asks', () => {
    const line = runLine(
      foldJournal(
        prRun((add) => {
          add(10, { type: 'span.started', spanId: 'node:team:0/ask:1/approval', parentSpanId: 'node:team:0/ask:1', kind: 'wait', name: 'Reviewer wants to use publish_notes', actor: person, caller: rev });
        }),
        { now: T0 + 20_000 },
      ),
    );
    expect(line.out).toMatchObject({ label: 'Needs you', detail: 'Reviewer wants to use publish_notes', tone: 'warn' });
  });

  it('says a run failed, with its error', () => {
    const line = runLine(
      foldJournal(
        prRun((add) => {
          add(20, { type: 'span.ended', spanId: 'node:team:0/ask:1', status: 'error', error: 'Typecheck failed' });
          add(21, { type: 'span.ended', spanId: 'node:team:0', status: 'error', error: 'Typecheck failed' });
          add(22, { type: 'span.ended', spanId: 'run', status: 'error', error: 'Typecheck failed' });
        }),
      ),
    );
    expect(line.out).toMatchObject({ label: 'Failed', detail: 'Typecheck failed', tone: 'bad' });
  });

  it('reads a manual run, a chat message and the reply when nothing was made', () => {
    const manual = foldJournal(
      journal((add) => {
        add(0, { type: 'span.started', spanId: 'run', kind: 'run', name: 'Notes', actor: flow });
        add(0, { type: 'span.started', spanId: 'node:m:0', parentSpanId: 'run', kind: 'step', name: 'When clicked', actor: { id: 'node:m', type: 'system', name: 'When clicked', nodeType: 'core.manualTrigger' }, nodeId: 'm' });
        add(1, { type: 'span.ended', spanId: 'node:m:0', status: 'success' });
        add(2, { type: 'span.ended', spanId: 'run', status: 'success' });
      }),
    );
    expect(runLine(manual).in).toMatchObject({ kind: 'manual', label: 'Run by you' });
    expect(runLine(manual).out).toMatchObject({ label: 'Done', tone: 'ok' });
    expect(runLine(manual).by.lead).toBeUndefined();
    const chat = foldJournal(
      journal((add) => {
        add(0, { type: 'span.started', spanId: 'run', kind: 'run', name: 'Support', actor: flow });
        add(0, { type: 'span.started', spanId: 'node:c:0', parentSpanId: 'run', kind: 'step', name: 'Chat', actor: { id: 'node:c', type: 'system', name: 'Chat', nodeType: 'core.chatTrigger' }, nodeId: 'c' });
        add(1, { type: 'span.ended', spanId: 'node:c:0', status: 'success', output: [{ json: { chatInput: 'Where is my order?' } }] });
        add(2, { type: 'span.started', spanId: 'node:a:0', parentSpanId: 'run', kind: 'agent', name: 'Nina', actor: { id: 'node:a', type: 'agent', name: 'Nina' }, nodeId: 'a' });
        add(3, { type: 'message', spanId: 'node:a:0', from: { id: 'node:a', type: 'agent', name: 'Nina' }, text: 'It ships tomorrow.' });
        add(4, { type: 'span.ended', spanId: 'node:a:0', status: 'success', output: 'It ships tomorrow.' });
        add(5, { type: 'span.ended', spanId: 'run', status: 'success' });
      }),
    );
    const line = runLine(chat);
    expect(line.in).toMatchObject({ kind: 'chat', label: 'Chat message', detail: 'Where is my order?' });
    expect(line.by.lead?.name).toBe('Nina');
    expect(line.out.label).toBe('Answered');
  });

  it('says what was answered in words, not a flow’s last output as data', () => {
    const model = foldJournal(
      journal((add) => {
        add(0, { type: 'span.started', spanId: 'run', kind: 'run', name: 'Notes', actor: flow });
        add(1, { type: 'span.started', spanId: 'node:team:0', parentSpanId: 'run', kind: 'agent', name: 'Team', actor: lead, nodeId: 'team', attrs: { team } });
        add(5, { type: 'span.ended', spanId: 'node:team:0', status: 'success', output: { reply: 'Here are the release notes for 0.9.0.' } });
        add(6, { type: 'span.started', spanId: 'node:pub:0', parentSpanId: 'run', kind: 'step', name: 'Publish', actor: { id: 'node:pub', type: 'system', name: 'Publish' }, nodeId: 'pub' });
        add(7, { type: 'span.ended', spanId: 'node:pub:0', status: 'success', output: { items: 0 } });
        add(8, { type: 'span.ended', spanId: 'run', status: 'success', output: { items: 0 } });
      }),
    );
    expect(runLine(model).out).toMatchObject({ label: 'Answered', detail: 'Here are the release notes for 0.9.0.' });
  });

  it('finds the first item’s json however the output keeps it', () => {
    expect(firstJson([[{ json: { a: 1 } }]])).toEqual({ a: 1 });
    expect(firstJson({ json: { b: 2 } })).toEqual({ b: 2 });
    expect(firstJson({ c: 3 })).toEqual({ c: 3 });
    expect(firstJson('text')).toBeUndefined();
  });
});

describe('GET /api/runs/lines', () => {
  const get = async (path: string) => {
    const response = await lines.GET(new Request(`http://localhost${path}`));
    return { status: response.status, body: (await response.json()) as any };
  };

  it('reads the lines of saved runs, leaving out the ones it cannot find', async () => {
    store.saveWorkflow({ id: 'wf_l', name: 'Build plugin', nodes: [], connections: [] });
    const start = new Date().toISOString();
    store.saveExecution({ executionId: 'ex_l1', workflowId: 'wf_l', workflowName: 'Build plugin', mode: 'manual', status: 'success', startedAt: start, finishedAt: start, durationMs: 9000, runData: {}, executionOrder: [] });
    const j = journalOf('ex_l1', { workflowId: 'wf_l' });
    const dev = { id: 'node:dev', name: 'Developer', type: 'agent' as const };
    j.record({ type: 'span.started', spanId: 'run', kind: 'run', name: 'Build plugin', actor: { id: 'workflow', name: 'Build plugin', type: 'system' }, at: start });
    j.record({ type: 'span.started', spanId: 'node:dev:0', parentSpanId: 'run', kind: 'agent', name: 'Developer', actor: dev, at: start });
    j.record({ type: 'artifact', spanId: 'node:dev:0', artifact: { name: 'PR #7', kind: 'pull_request', url: 'https://github.com/o/r/pull/7' }, at: start });
    j.record({ type: 'span.ended', spanId: 'node:dev:0', status: 'success', at: start });
    j.record({ type: 'span.ended', spanId: 'run', status: 'success', at: start });
    releaseJournal('ex_l1');

    const { status, body } = await get('/api/runs/lines?ids=ex_l1,ex_missing');
    expect(status).toBe(200);
    expect(Object.keys(body.lines)).toEqual(['ex_l1']);
    expect(body.lines.ex_l1.out).toMatchObject({ label: 'Pull request opened', detail: 'PR #7' });
    expect(body.lines.ex_l1.by.lead.name).toBe('Developer');
    expect((await get('/api/runs/lines')).status).toBe(400);
    expect((await get(`/api/runs/lines?ids=${Array.from({ length: 21 }, (_, i) => `e${i}`).join(',')}`)).status).toBe(400);
  });
});
