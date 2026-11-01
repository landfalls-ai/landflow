/**
 * Reviews and comments left through GitHub's MCP tools as Run Trace artifacts (lib/shared/review-comments.ts,
 * lib/server/journal/agent-session.ts): what each tool call makes of them, the journal of a Landflow agent's call and of a
 * Claude Code member's `mcp__<server>__<tool>` step, and the Story's card in the member's words.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isReviewComment, reviewCommentCard, reviewCommentOf } from '@/lib/shared/review-comments';
import { foldJournal, storyOf } from '@/lib/shared/run-trace-model';
import type { JournalEvent } from '@/lib/shared/run-trace';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-review-comments-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { journalOf, journalStore, releaseJournal, resetJournals } = await import('@/lib/server/journal');
const { agentSessionJournal } = await import('@/lib/server/journal/agent-session');

afterAll(() => {
  resetJournals();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const REPO = { owner: 'landfalls', repo: 'landflow' };

describe('what a GitHub MCP call makes of a review comment', () => {
  it('a line comment on a pending review: repository, pull request, path, line and body', () => {
    const artifact = reviewCommentOf('add_comment_to_pending_review', { ...REPO, pullNumber: 5, path: 'src/nodes/get-alerts.ts', line: 42, side: 'RIGHT', subjectType: 'LINE', body: 'This drops the severity filter.' }, 'ok');
    expect(artifact).toEqual({
      name: 'Comment on src/nodes/get-alerts.ts line 42 (landfalls/landflow#5)',
      kind: 'review_comment',
      text: 'This drops the severity filter.',
      data: { action: 'line', repository: 'landfalls/landflow', number: 5, path: 'src/nodes/get-alerts.ts', line: 42 },
    });
    expect(isReviewComment(artifact!)).toBe(true);
  });

  it('a submitted review: its verdict, body and the URL GitHub returned; a pending one leaves nothing yet', () => {
    const output = { content: [{ type: 'text', text: JSON.stringify({ id: 9, html_url: 'https://github.com/landfalls/landflow/pull/5#pullrequestreview-9', url: 'https://api.github.com/x' }) }] };
    expect(reviewCommentOf('pull_request_review_write', { ...REPO, pullNumber: 5, method: 'create', event: 'APPROVE', body: 'Looks good.' }, output)).toMatchObject({
      name: 'Review of landfalls/landflow#5: approve',
      kind: 'review_comment',
      url: 'https://github.com/landfalls/landflow/pull/5#pullrequestreview-9',
      text: 'Looks good.',
      data: { action: 'review', number: 5, verdict: 'APPROVE' },
    });
    expect(reviewCommentOf('pull_request_review_write', { ...REPO, pullNumber: 5, method: 'submit_pending', event: 'REQUEST_CHANGES', body: 'Two things.' })?.data).toMatchObject({ verdict: 'REQUEST_CHANGES' });
    expect(reviewCommentOf('pull_request_review_write', { ...REPO, pullNumber: 5, method: 'create' })).toBeUndefined();
    expect(reviewCommentOf('pull_request_review_write', { ...REPO, pullNumber: 5, method: 'delete_pending' })).toBeUndefined();
    expect(reviewCommentOf('pull_request_review_write', { ...REPO, pullNumber: 5, method: 'resolve_thread', threadId: 't' })).toBeUndefined();
  });

  it('a comment on a pull request or issue, and a reply to a review comment', () => {
    expect(reviewCommentOf('add_issue_comment', { ...REPO, issue_number: 7, body: 'Thanks' }, 'https://github.com/landfalls/landflow/pull/7#issuecomment-1')).toMatchObject({
      name: 'Comment on landfalls/landflow#7',
      url: 'https://github.com/landfalls/landflow/pull/7#issuecomment-1',
      data: { action: 'comment', number: 7 },
    });
    expect(reviewCommentOf('add_reply_to_pull_request_comment', { ...REPO, pullNumber: 5, commentId: 3, body: 'Fixed' })?.data).toMatchObject({ action: 'reply', number: 5 });
  });

  it('reads the tool from a Claude Code step’s mcp__<server>__ name, and ignores other tools and other servers', () => {
    expect(reviewCommentOf('mcp__github__add_issue_comment', { ...REPO, issue_number: 7, body: 'Hi' })?.kind).toBe('review_comment');
    expect(reviewCommentOf('mcp__github__pull_request_read', { ...REPO, pullNumber: 5 })).toBeUndefined();
    expect(reviewCommentOf('add_issue_comment', { body: 'No owner or repository' })).toBeUndefined();
    expect(reviewCommentOf('add_issue_comment', { ...REPO, issue_number: 7, body: '  ' })).toBeUndefined();
  });
});

describe('the card in the member’s words', () => {
  it('says what a member did and quotes what they wrote', () => {
    const line = reviewCommentOf('add_comment_to_pending_review', { ...REPO, pullNumber: 5, path: 'src/nodes/get-alerts.ts', line: 42, body: 'Check the filter.' })!;
    expect(reviewCommentCard(line)).toEqual({ verb: 'commented on src/nodes/get-alerts.ts line 42', quote: 'Check the filter.' });
    const review = reviewCommentOf('pull_request_review_write', { ...REPO, pullNumber: 5, method: 'create', event: 'REQUEST_CHANGES', body: 'See comments.' }, 'https://github.com/landfalls/landflow/pull/5#pullrequestreview-2')!;
    expect(reviewCommentCard(review)).toEqual({ verb: 'reviewed pull request #5: request changes', quote: 'See comments.', verdict: 'REQUEST_CHANGES', url: 'https://github.com/landfalls/landflow/pull/5#pullrequestreview-2' });
    expect(reviewCommentCard({ name: 'Something else', kind: 'review_comment' })).toEqual({ verb: 'Something else' });
  });
});

describe('the journal', () => {
  const read = (id: string): JournalEvent[] => journalStore.read(id);
  const artifacts = (events: JournalEvent[]) => events.filter((e): e is Extract<JournalEvent, { type: 'artifact' }> => e.type === 'artifact');

  it('records a Landflow agent’s successful call under the call’s span, and none for a read, a failure or a pending review', () => {
    const journal = journalOf('ex_rc_agent', { workflowId: 'wf_rc' });
    journal.bindSpans(
      (nodeId) => (nodeId === 'rev' ? 'node:rev:0' : undefined),
      (nodeId) => (nodeId === 'rev' ? { id: 'node:rev', name: 'Reviewer', type: 'agent', nodeType: 'core.messageAgent' } : undefined),
    );
    const entry = agentSessionJournal({ execution: { workflowId: 'wf_rc', executionId: 'ex_rc_agent', nodeId: 'rev' } }, { id: 'ag_rev', name: 'Reviewer' });
    const call = (callId: string, tool: string, input: Record<string, unknown>, patch: Record<string, unknown> = {}) =>
      ({ id: callId, type: 'tool', callId, tool, label: `GitHub MCP · ${tool}`, kind: 'node', nodeType: 'core.mcpClientTool', input, status: 'success', output: 'done', at: '2026-11-01T10:00:00.000Z', ...patch }) as never;
    entry(call('c1', 'add_comment_to_pending_review', { ...REPO, pullNumber: 5, path: 'src/nodes/get-alerts.ts', line: 42, body: 'Check the filter.' }));
    entry(call('c2', 'pull_request_read', { ...REPO, pullNumber: 5, method: 'get' }));
    entry(call('c3', 'add_issue_comment', { ...REPO, issue_number: 5, body: 'Lost' }, { status: 'error', error: 'forbidden', output: undefined }));
    entry(call('c4', 'pull_request_review_write', { ...REPO, pullNumber: 5, method: 'create' }));
    entry(call('c5', 'pull_request_review_write', { ...REPO, pullNumber: 5, method: 'submit_pending', event: 'APPROVE', body: 'Good.' }, { output: { html_url: 'https://github.com/landfalls/landflow/pull/5#pullrequestreview-3' } }));
    // The same call journaled again (an upsert after it ended) adds nothing.
    entry(call('c5', 'pull_request_review_write', { ...REPO, pullNumber: 5, method: 'submit_pending', event: 'APPROVE', body: 'Good.' }));
    releaseJournal('ex_rc_agent');
    const events = read('ex_rc_agent');
    const made = artifacts(events);
    expect(made.map((e) => e.spanId)).toEqual(['node:rev:0/step:c1', 'node:rev:0/step:c5']);
    expect(made[0].artifact).toMatchObject({ kind: 'review_comment', text: 'Check the filter.', data: { path: 'src/nodes/get-alerts.ts', line: 42 } });
    expect(made[1].artifact).toMatchObject({ kind: 'review_comment', url: 'https://github.com/landfalls/landflow/pull/5#pullrequestreview-3', data: { action: 'review', verdict: 'APPROVE' } });

    // The run's story tells it in the member's words, and the model lists it among the artifacts.
    const model = foldJournal(events);
    expect(model.artifacts.map((a) => a.actor?.name)).toEqual(['Reviewer', 'Reviewer']);
    const cards = storyOf(model).flatMap((s) => (s.type === 'artifact' ? [s.item] : []));
    expect(cards.map((c) => reviewCommentCard(c.artifact).verb)).toEqual(['commented on src/nodes/get-alerts.ts line 42', 'reviewed pull request #5: approve']);
  });

  it('records a Claude Code member’s mcp__github__ step when it ends successfully', () => {
    const journal = journalOf('ex_rc_remote', { workflowId: 'wf_rc' });
    journal.bindSpans((nodeId) => (nodeId === 'member' ? 'node:member:0' : undefined));
    const entry = agentSessionJournal({ execution: { workflowId: 'wf_rc', executionId: 'ex_rc_remote', nodeId: 'member' } }, { id: 'ag_lead', name: 'Lead' });
    const remote = (steps: unknown[], state = 'working') => ({ agent: 'Reviewer', state, steps });
    const a2a = (state: string, steps: unknown[], status = 'running') =>
      ({ id: 't1', type: 'tool', callId: 'r1', tool: 'ask_reviewer', label: 'Reviewer', kind: 'a2a', input: {}, status, remote: remote(steps, state), at: '2026-11-01T10:00:00.000Z' }) as never;
    const comment = { id: 's1', name: 'mcp__github__add_issue_comment', args: { ...REPO, issue_number: 5, body: 'Needs a test.' }, status: 'success', output: '{"html_url":"https://github.com/landfalls/landflow/pull/5#issuecomment-8"}' };
    const lookup = { id: 's2', name: 'mcp__github__pull_request_read', args: { ...REPO, pullNumber: 5 }, status: 'success', output: '{}' };
    entry(a2a('working', [{ ...comment, status: 'running' }, lookup]));
    entry(a2a('working', [comment, lookup]));
    entry(a2a('working', [comment, lookup]));
    entry(a2a('completed', [comment, lookup], 'success'));
    releaseJournal('ex_rc_remote');
    const made = artifacts(read('ex_rc_remote'));
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ spanId: 'node:member:0/step:r1/step:s1', artifact: { kind: 'review_comment', text: 'Needs a test.', url: 'https://github.com/landfalls/landflow/pull/5#issuecomment-8', data: { action: 'comment', number: 5 } } });
  });
});
