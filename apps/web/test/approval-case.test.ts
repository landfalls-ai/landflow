/**
 * An approval with its evidence (lib/shared/approval-case.ts, approval-evidence.ts): what the member says, the case made
 * readable, the button named by the action, the edit turned into an input, the evidence rows and the faces of who waits.
 */
import { describe, expect, it } from 'vitest';
import type { JournalEvent, RunActor } from '@/lib/shared/run-trace';
import { foldJournal, type NeedsYouItem } from '@/lib/shared/run-trace-model';
import { approvalCase, editedInput, readableTool, verbOf, type ApprovalWait } from '@/lib/shared/approval-case';
import { approvalEvidence, listFaces, needsFaces } from '@/lib/shared/approval-evidence';
import { RUN_PROFILES } from '@/lib/shared/run-profiles';

const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const flow: RunActor = { id: 'workflow', type: 'system', name: 'Tech Review Workflow' };
const lead: RunActor = { id: 'node:team', type: 'agent', name: 'Tech Lead' };
const rev: RunActor = { id: 'member:rev', type: 'agent', name: 'Reviewer' };
const person: RunActor = { id: 'human', type: 'human', name: 'A person' };
const team = {
  id: 't1',
  name: 'Tech Lead team',
  members: [
    { id: 'l', title: 'Tech Lead', kind: 'agent' },
    { id: 'r', title: 'Reviewer', kind: 'agent', reportsTo: 'l', budgetTokens: 100_000 },
    { id: 'd', title: 'Developer', kind: 'agent', reportsTo: 'l' },
  ],
};

const REVIEW_INPUT = { method: 'create', owner: 'acme', repo: 'plugins', pullNumber: 5, event: 'APPROVE', body: 'Looks good. The tests cover the new route.' };

function journal(build: (add: (time: number, e: Record<string, unknown>) => void) => void): JournalEvent[] {
  let seq = 0;
  const list: JournalEvent[] = [];
  build((time, e) => list.push({ seq: ++seq, executionId: 'x1', at: at(time), ...e } as JournalEvent));
  return list;
}

/** A team run in which the Reviewer worked, checked, and now waits for a person to approve its review. */
function waiting(attrs: Record<string, unknown>) {
  return foldJournal(
    journal((add) => {
      add(0, { type: 'span.started', spanId: 'run', kind: 'run', name: 'Tech Review Workflow', actor: flow });
      add(1, { type: 'span.started', spanId: 'node:team:0', parentSpanId: 'run', kind: 'agent', name: 'Team', actor: lead, nodeId: 'team', attrs: { team } });
      add(2, { type: 'span.started', spanId: 'node:team:0/ask:1', parentSpanId: 'node:team:0', kind: 'delegate', name: 'Review #5', actor: rev, caller: lead, input: 'Review #5', attrs: { reason: 'Review the alerts plugin before it merges' } });
      add(30, { type: 'check', spanId: 'node:team:0/ask:1', check: { name: 'Tests', status: 'pass', message: '14 tests pass', subject: 'Reviewer' } });
      add(31, { type: 'check', spanId: 'node:team:0/ask:1', check: { name: 'Typecheck', status: 'fail', message: '3 errors', subject: 'Reviewer' } });
      add(32, { type: 'check', spanId: 'node:team:0/ask:1', check: { name: 'Approval', status: 'pass', message: 'someone approved', subject: 'Reviewer' } });
      add(40, { type: 'message', spanId: 'node:team:0/ask:1', from: rev, to: lead, text: 'The route is covered and the types hold. I recommend approving. Nothing else blocks it.' });
      add(50, { type: 'span.started', spanId: 'run/wait:1', parentSpanId: 'run', kind: 'wait', name: 'Reviewer wants to use Review pull request', actor: person, caller: lead, attrs });
    }),
    { now: T0 + 170_000 },
  );
}

const reviewAttrs = { wait: 'approval', member: 'Reviewer', tool: 'Review pull request', target: '#5', summary: 'Looks good.', calls: [{ id: 'r/c1', tool: 'Review pull request', input: REVIEW_INPUT }] };
const waitOf = (model: ReturnType<typeof waiting>): ApprovalWait => model.needsYou.find((n): n is ApprovalWait => n.kind === 'wait')!;

describe('the case of an approval', () => {
  it('reads a review: the repository and number, the verdict and its text, a button that names both', () => {
    const model = waiting(reviewAttrs);
    const c = approvalCase(waitOf(model), model);
    expect(c).toMatchObject({ member: 'Reviewer', toolName: 'Review pull request', target: 'plugins · #5', kind: 'review', verdict: 'approve', verb: 'Post review & approve', callId: 'r/c1' });
    expect(c.rows).toEqual([
      { label: 'Verdict', value: 'Approve' },
      { label: 'Review', value: 'Looks good. The tests cover the new route.', block: true },
    ]);
    expect(c.edit).toEqual({ kind: 'review', verdict: 'approve', body: 'Looks good. The tests cover the new route.' });
  });

  it('names the button of a review that asks for changes, or only comments', () => {
    const changes = waiting({ ...reviewAttrs, calls: [{ id: 'r/c1', tool: 'Review pull request', input: { ...REVIEW_INPUT, event: 'REQUEST_CHANGES' } }] });
    expect(approvalCase(waitOf(changes), changes).verb).toBe('Post review & request changes');
    const comment = waiting({ ...reviewAttrs, calls: [{ id: 'r/c1', tool: 'Review pull request', input: { ...REVIEW_INPUT, event: 'COMMENT' } }] });
    expect(approvalCase(waitOf(comment), comment).verb).toBe('Post review comment');
  });

  it('shows a command in mono, a file write by its path, and anything else as key: value lines', () => {
    const cmd = waiting({ wait: 'approval', member: 'Developer', tool: 'Bash', calls: [{ id: 'd/c2', tool: 'Bash', input: { command: 'pnpm test --filter plugins', cwd: '/work/plugins' } }] });
    expect(approvalCase(waitOf(cmd), cmd)).toMatchObject({ kind: 'command', verb: 'Run the command', rows: [{ label: 'Command', value: 'pnpm test --filter plugins', mono: true, block: true }, { label: 'In', value: '/work/plugins', mono: true }] });

    const file = waiting({ wait: 'approval', member: 'Developer', tool: 'Write', calls: [{ id: 'd/c3', tool: 'Write', input: { path: 'src/alerts.ts', content: 'export {}' } }] });
    const written = approvalCase(waitOf(file), file);
    expect(written).toMatchObject({ kind: 'file', target: 'src/alerts.ts', verb: 'Write the file' });
    expect(written.rows[0]).toEqual({ label: 'Path', value: 'src/alerts.ts', mono: true });

    const other = waiting({ wait: 'approval', member: 'Writer', tool: 'Fetch page', calls: [{ id: 'w/c4', tool: 'Fetch page', input: { url: 'https://example.com', retries: 2, headers: { a: 'b' } } }] });
    const c = approvalCase(waitOf(other), other);
    expect(c).toMatchObject({ kind: 'other', verb: 'Approve: Fetch page' });
    expect(c.rows.map((r) => `${r.label}: ${r.value}`)).toEqual(['url: https://example.com', 'retries: 2', 'headers: {"a":"b"}']);
  });

  it('names publishing notes, and a guard’s ask by its command', () => {
    const notes = waiting({ wait: 'approval', member: 'Writer', tool: 'publish_notes', calls: [{ id: 'w/c5', tool: 'publish_notes', input: { title: 'Release notes' } }] });
    expect(approvalCase(waitOf(notes), notes)).toMatchObject({ kind: 'publish', toolName: 'Publish notes', verb: 'Publish notes' });
    const ask = waiting({ wait: 'approval', ask: 'ask_1', tool: 'Bash', command: 'git push origin main', member: 'Developer', reason: 'Pushing the fix to main.' });
    expect(approvalCase(waitOf(ask), ask)).toMatchObject({ kind: 'command', ask: 'ask_1', verb: 'Run the command', words: 'Pushing the fix to main.', edit: { kind: 'command', command: 'git push origin main' } });
    expect(verbOf('other', 'merge_pull_request')).toBe('Approve: Merge pull request');
    expect(readableTool('pull_request_review_write')).toBe('Pull request review write');
    expect(readableTool('Comment on pull request')).toBe('Comment on pull request');
  });

  it('puts what the member said in its own words: the reason it was asked, then its last message before the wait', () => {
    const model = waiting(reviewAttrs);
    const words = approvalCase(waitOf(model), model).words!;
    expect(words).toContain('Review the alerts plugin before it merges');
    expect(words).toContain('The route is covered and the types hold.');
    // Two sentences at most, cut.
    expect(words).not.toContain('Nothing else blocks it');
    expect(words.length).toBeLessThanOrEqual(300);
  });
});

describe('an edited input', () => {
  const model = waiting(reviewAttrs);
  const c = approvalCase(waitOf(model), model);

  it('keeps the review’s other fields and changes the verdict and body, in the style the input used', () => {
    const result = editedInput(c, { kind: 'review', verdict: 'request_changes', body: 'Please add a test for the 404.' });
    expect(result).toEqual({ ok: true, changed: true, input: { ...REVIEW_INPUT, event: 'REQUEST_CHANGES', body: 'Please add a test for the 404.' } });
    expect(editedInput(c, c.edit)).toMatchObject({ ok: true, changed: false });
  });

  it('turns a command into the whole input, or for a guard’s ask the command itself', () => {
    const cmd = waiting({ wait: 'approval', member: 'Developer', tool: 'Bash', calls: [{ id: 'd/c2', tool: 'Bash', input: { command: 'rm -rf build', cwd: '/w' } }] });
    const cc = approvalCase(waitOf(cmd), cmd);
    expect(editedInput(cc, { kind: 'command', command: ' rm -rf build/cache ' })).toEqual({ ok: true, changed: true, input: { command: ' rm -rf build/cache '.trim(), cwd: '/w' } });
    expect(editedInput(cc, { kind: 'command', command: '  ' })).toMatchObject({ ok: false });
    const ask = waiting({ wait: 'approval', ask: 'ask_1', tool: 'Bash', command: 'git push origin main', member: 'Developer' });
    expect(editedInput(approvalCase(waitOf(ask), ask), { kind: 'command', command: 'git push origin fix' })).toEqual({ ok: true, changed: true, command: 'git push origin fix' });
  });

  it('takes JSON only when it is an object', () => {
    const other = waiting({ wait: 'approval', member: 'Writer', tool: 'Fetch page', calls: [{ id: 'w/c4', tool: 'Fetch page', input: { url: 'https://example.com' } }] });
    const oc = approvalCase(waitOf(other), other);
    expect(editedInput(oc, { kind: 'json', json: '{"url":"https://example.org"}' })).toEqual({ ok: true, changed: true, input: { url: 'https://example.org' } });
    expect(editedInput(oc, { kind: 'json', json: '[1]' })).toEqual({ ok: false, error: 'The input must be a JSON object' });
    expect(editedInput(oc, { kind: 'json', json: '{' })).toMatchObject({ ok: false });
  });
});

describe('what the member looked at', () => {
  it('lists only rows that have data, in the order a person weighs them, each leading somewhere', () => {
    const model = waiting(reviewAttrs);
    const rows = approvalEvidence(model, waitOf(model), { now: T0 + 170_000, profile: RUN_PROFILES.generic });
    expect(rows.map((r) => r.id)).toEqual(['asked', 'checks', 'time']);
    expect(rows[0]).toMatchObject({ detail: '2m 00s ago', link: { open: { kind: 'span', id: 'run/wait:1' } } });
    // The Approval check is a decision, not evidence.
    expect(rows[1]).toMatchObject({ detail: '1 passed · 1 failed (Typecheck)', tone: 'bad', link: { open: { kind: 'check' } } });
    expect(rows[2].detail).toContain('2m 50s');
  });

  it('adds the budget used against the member’s own, and the code it changed', () => {
    // The Reviewer used 85k of its 100k tokens.
    const events = journal((add) => {
      add(0, { type: 'span.started', spanId: 'run', kind: 'run', name: 'Tech Review Workflow', actor: flow });
      add(1, { type: 'span.started', spanId: 'node:team:0', parentSpanId: 'run', kind: 'agent', name: 'Team', actor: lead, nodeId: 'team', attrs: { team } });
      add(2, { type: 'span.started', spanId: 'node:team:0/ask:1', parentSpanId: 'node:team:0', kind: 'delegate', name: 'Review #5', actor: rev, caller: lead });
      add(20, { type: 'span.ended', spanId: 'node:team:0/ask:1', status: 'success', usage: { inputTokens: 80_000, outputTokens: 5_000 } });
      add(50, { type: 'span.started', spanId: 'run/wait:1', parentSpanId: 'run', kind: 'wait', name: 'Reviewer wants to use Review pull request', actor: person, caller: lead, attrs: reviewAttrs });
    });
    const model = foldJournal(events, { now: T0 + 60_000 });
    const changes = { git: true, agents: [rev], changes: 3, notPushed: 0, files: [{ path: 'a.ts', additions: 12, deletions: 2, actors: [{ actor: rev }] }, { path: 'b.ts', additions: 4, deletions: 0, actors: [{ actor: rev }] }, { path: 'c.ts', additions: 99, deletions: 9, actors: [{ actor: lead }] }] };
    const rows = approvalEvidence(model, waitOf(model), { now: T0 + 60_000, changes: changes as never });
    expect(rows.find((r) => r.id === 'budget')).toMatchObject({ detail: '85k of 100k tokens (85%)', tone: 'warn', link: { tab: 'team', member: 'Reviewer' } });
    expect(rows.find((r) => r.id === 'changes')).toMatchObject({ detail: '+16 −2 in 2 files', link: { tab: 'artifacts' } });
  });

  it('is empty-handed for a wait that names no member, except when it asked and for how long the run went', () => {
    const model = waiting({ wait: 'approval', calls: [{ id: 'c', tool: 'Send email', input: {} }] });
    expect(approvalEvidence(model, waitOf(model), { now: T0 + 170_000 }).map((r) => r.id)).toEqual(['asked', 'time']);
  });
});

describe('who has something for you', () => {
  it('shows the team as faces with a dot on each that waits, those first', () => {
    const model = waiting(reviewAttrs);
    const faces = needsFaces(model, model.needsYou);
    expect(faces.map((f) => [f.name, f.waiting])).toEqual([
      ['Reviewer', true],
      ['Tech Lead', false],
      ['Developer', false],
    ]);
    expect(faces[0].actor.id).toBe('member:rev');
  });

  it('draws no row for one face, or when nobody waits', () => {
    const solo = foldJournal(journal((add) => add(0, { type: 'span.started', spanId: 'run', kind: 'run', name: 'Run', actor: flow })));
    expect(needsFaces(solo, [])).toEqual([]);
    const items: NeedsYouItem[] = [{ kind: 'wait', spanId: 's', actor: person, title: 't', since: at(0), attrs: { wait: 'approval', member: 'Writer' } }];
    expect(needsFaces(solo, items)).toEqual([]);
  });

  it('counts a member’s things across runs', () => {
    const faces = listFaces([{ member: 'Reviewer' }, { member: 'reviewer' }, { member: 'Writer' }, {}]);
    expect(faces.map((f) => [f.name, f.count])).toEqual([['Reviewer', 2], ['Writer', 1]]);
  });
});
