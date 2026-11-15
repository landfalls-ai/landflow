/** Project tasks on screen: the wake-up presets, Needs you actions for a task, the list order, the tabs and the markup (contracts/w10/tasks-api.md). */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { actionsFor } from '../src/components/run-trace/needs-you-actions';
import { TaskRow as NeedsYouTaskRow } from '../src/components/run-trace/run-lists';
import { PROJECT_TABS, projectTab } from '../src/components/projects/project-tabs';
import { TaskCard, TaskRow } from '../src/components/projects/tasks/task-row';
import { ScheduleField } from '../src/components/projects/tasks/task-dialog';
import { cronPreset, presetCron, WAKE_NOTE, WAKE_PRESETS } from '../src/components/projects/tasks/schedule';
import { assigneeValue, fieldOfError, groupTasks, missingAssigneeOption, parseAssignee } from '../src/components/projects/tasks/tasks-model';
import { tasksUrl } from '../src/components/projects/tasks/use-tasks';
import { deletionNotice } from '../src/components/projects/project-dialogs';
import type { NeedsYouRow } from '../src/lib/client/run-trace';
import type { ProjectTaskView } from '../src/lib/shared/project-tasks';

const ledger: ProjectTaskView = {
  id: 'tsk_ledger1', projectId: 'prj_billing01', goalId: 'gol_invoices', title: 'Reconcile the October ledger', description: 'Compare the ledger export with the bank feed.',
  status: 'todo', priority: 'high', assignee: { kind: 'agent', id: 'agt_clerk' }, assigneeName: 'Ledger clerk', wake: { cron: '0 9 * * 1-5' }, nextWakeAt: '2026-11-16T09:00:00.000Z',
  goalTitle: 'Close invoices in two days', createdAt: '2026-11-15T08:00:00.000Z', updatedAt: '2026-11-15T08:00:00.000Z', createdBy: 'usr_ana',
  runs: [
    { id: 'trn_2', taskId: 'tsk_ledger1', projectId: 'prj_billing01', agentId: 'agt_clerk', status: 'requested', reason: 'wake', requestedAt: '2026-11-15T09:00:00.000Z' },
    { id: 'trn_1', taskId: 'tsk_ledger1', projectId: 'prj_billing01', agentId: 'agt_clerk', status: 'done', reason: 'manual', requestedAt: '2026-11-14T10:00:00.000Z', requestedBy: 'usr_ana', decidedBy: 'usr_ben', decidedAt: '2026-11-14T10:02:00.000Z', sessionId: 'as_k2v9q1', reply: 'Two entries differ: …', finishedAt: '2026-11-14T10:04:10.000Z' },
  ],
  canEdit: true, canRelease: false,
};
const vendor: ProjectTaskView = {
  id: 'tsk_vendor2', projectId: 'prj_billing01', title: 'Call the paper vendor', status: 'in_progress', priority: 'normal', assignee: { kind: 'person', id: 'usr_ben' }, assigneeName: 'Ben Example',
  checkedOutBy: 'usr_ben', checkedOutByName: 'Ben Example', createdAt: '2026-11-13T08:00:00.000Z', updatedAt: '2026-11-15T07:30:00.000Z', runs: [], canEdit: true, canRelease: false,
};

describe('wake-up presets', () => {
  it('round trips the four presets', () => {
    for (const p of ['daily', 'weekdays', 'weekly'] as const) expect(cronPreset(presetCron(p))).toBe(p);
    expect(presetCron('none')).toBeUndefined();
    expect(cronPreset(undefined)).toBe('none');
    expect(cronPreset('')).toBe('none');
    expect(WAKE_PRESETS).toHaveLength(5);
  });
  it('calls anything else custom', () => {
    expect(cronPreset('30 8 * * 1-5')).toBe('custom');
    expect(presetCron('custom')).toBeUndefined();
    expect(cronPreset(' 0  9 * * 1 ')).toBe('weekly');
  });
});

describe('Needs you actions for a task', () => {
  it('offers Approve, Deny and Open task to one who may decide', () => {
    expect(actionsFor({ kind: 'task', taskRunStatus: 'requested', canDecide: true })).toEqual([{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }, { id: 'open', label: 'Open task' }]);
  });
  it('offers only Open task without the right to decide, and Open session while waiting', () => {
    expect(actionsFor({ kind: 'task', taskRunStatus: 'requested', canDecide: false })).toEqual([{ id: 'open', label: 'Open task' }]);
    expect(actionsFor({ kind: 'task', taskRunStatus: 'waiting', canDecide: false })).toEqual([{ id: 'open', label: 'Open session' }]);
  });
  it('leaves a budget item as it was', () => {
    expect(actionsFor({ kind: 'budget', incidentKind: 'stop', canRaise: true, canResume: true }).map((a) => a.id)).toEqual(['resume', 'raise', 'open']);
    expect(actionsFor({ kind: 'budget', incidentKind: 'warn', canResume: true }).map((a) => a.id)).toEqual(['dismiss', 'open']);
    expect(actionsFor({ kind: 'approval' })).toEqual([]);
  });
});

describe('the list', () => {
  it('groups by status, then priority, then newest', () => {
    const a = { ...vendor, id: 'a', status: 'todo' as const, priority: 'low' as const, updatedAt: '2026-11-15T10:00:00.000Z' };
    const b = { ...vendor, id: 'b', status: 'todo' as const, priority: 'high' as const, updatedAt: '2026-11-10T10:00:00.000Z' };
    const c = { ...vendor, id: 'c', status: 'todo' as const, priority: 'high' as const, updatedAt: '2026-11-14T10:00:00.000Z' };
    const done = { ...vendor, id: 'd', status: 'done' as const };
    const groups = groupTasks([done, a, ledger, vendor, b, c]);
    expect(groups.map((g) => g.label)).toEqual(['In progress', 'To do', 'Done']);
    expect(groups[1].tasks.map((t) => t.id)).toEqual(['tsk_ledger1', 'c', 'b', 'a']);
    expect(groupTasks([])).toEqual([]);
  });
  it('builds the paging url', () => {
    expect(tasksUrl('prj_1', {})).toBe('/api/projects/prj_1/tasks');
    expect(tasksUrl('prj_1', { status: 'todo', mine: true }, 'abc')).toBe('/api/projects/prj_1/tasks?status=todo&mine=1&cursor=abc');
  });
  it('reads the assignee and the field a message is about', () => {
    expect(parseAssignee(assigneeValue({ kind: 'agent', id: 'agt_clerk' }))).toEqual({ kind: 'agent', id: 'agt_clerk' });
    expect(parseAssignee('')).toBeUndefined();
    expect(fieldOfError('Only an agent task has a wake-up schedule')).toBe('schedule');
    expect(fieldOfError('This schedule never fires')).toBe('schedule');
    expect(fieldOfError('That goal isn’t one of this project’s goals')).toBe('goal');
    expect(fieldOfError('Ben isn’t a member of this project')).toBe('assignee');
    expect(fieldOfError('A project has at most 1000 tasks')).toBeUndefined();
    expect(fieldOfError('Jane Mansfield isn’t a member of this project')).toBe('assignee');
    expect(fieldOfError('“Clerk” isn’t allowed in project “Q4 goals” (Project settings → Agents)')).toBe('assignee');
    expect(fieldOfError('“Cron helper” isn’t available in project “Billing”')).toBe('assignee');
    expect(fieldOfError('A wake-up schedule has five fields')).toBe('schedule');
  });

  it('offers the saved assignee when it is not loaded', () => {
    expect(missingAssigneeOption('agent:a1', [{ id: 'a1' }], [])).toBeUndefined();
    expect(missingAssigneeOption('agent:a2', [{ id: 'a1' }], [], 'Clerk')).toEqual({ value: 'agent:a2', label: 'Clerk' });
    expect(missingAssigneeOption('person:p1', [], [])).toEqual({ value: 'person:p1', label: 'Removed person' });
    expect(missingAssigneeOption('', [], [])).toBeUndefined();
  });
});

describe('the tabs', () => {
  it('has the Tasks tab after the Overview', () => {
    expect(PROJECT_TABS.map((t) => t.id)).toEqual(['overview', 'tasks', 'members', 'settings', 'audit']);
    expect(projectTab('tasks')).toBe('tasks');
  });
  it('maps the old values as before', () => {
    expect(projectTab('workflows')).toBe('overview');
    expect(projectTab('variables')).toBe('settings');
    expect(projectTab('audit')).toBe('audit');
    expect(projectTab(null)).toBe('overview');
    expect(projectTab('nonsense')).toBe('overview');
  });
});

describe('markup', () => {
  it('renders an agent row and a person row', () => {
    const agent = renderToStaticMarkup(createElement(TaskRow, { task: ledger, onOpen: () => {} }));
    expect(agent).toContain('Reconcile the October ledger');
    expect(agent).toContain('Ledger clerk');
    expect(agent).toContain('High');
    expect(agent).toContain('Close invoices in two days');
    expect(agent).toContain('0 9 * * 1-5');
    expect(agent).toContain('Asked');
    const person = renderToStaticMarkup(createElement(TaskRow, { task: vendor, onOpen: () => {} }));
    expect(person).toContain('Ben Example');
    expect(person).toContain('No runs');
    expect(person).toContain('held by Ben Example');
  });
  it('renders the phone card with 44 px target', () => {
    const html = renderToStaticMarkup(createElement(TaskCard, { task: ledger, onOpen: () => {} }));
    expect(html).toContain('min-h-[44px]');
    expect(html).toContain('Ledger clerk');
  });
  it('renders the schedule note and the next wake-up', () => {
    const html = renderToStaticMarkup(createElement(ScheduleField, { preset: 'weekdays', cron: '', onPreset: () => {}, onCron: () => {}, nextWakeAt: '2026-11-16T09:00:00.000Z' }));
    expect(html).toContain(WAKE_NOTE);
    expect(html).toContain('Weekdays 9:00');
    expect(html).toContain('Next wake-up');
    expect(renderToStaticMarkup(createElement(ScheduleField, { preset: 'custom', cron: '5 4 * * *', onPreset: () => {}, onCron: () => {} }))).toContain('Cron schedule');
  });
  it('renders a Needs you task row that links to its href and never to a run', () => {
    const item: NeedsYouRow = {
      executionId: '', workflowId: '', workflowName: '', kind: 'task', projectId: 'prj_billing01', taskId: 'tsk_ledger1', taskRunId: 'trn_2', taskRunStatus: 'requested',
      title: '“Ledger clerk” wants to work on “Reconcile the October ledger”', detail: 'Wake-up (0 9 * * 1-5)', href: '/projects/prj_billing01?tab=tasks&task=tsk_ledger1', canDecide: true, since: '2026-11-15T09:00:00.000Z',
    };
    const html = renderToStaticMarkup(createElement(NeedsYouTaskRow, { item }));
    expect(html).toContain('href="/projects/prj_billing01?tab=tasks&amp;task=tsk_ledger1"');
    expect(html).not.toContain('/runs/');
    expect(html).toContain('Task');
    expect(html).toContain('Approve');
    expect(html).toContain('Deny');
    expect(html).toContain('max-md:min-h-[44px]');
  });
});

describe('deleting a project says what goes with it', () => {
  it('names the tasks it deletes, never promises nothing is deleted', () => {
    const notice = deletionNotice({ counts: {}, taskCount: 12 });
    expect(notice.deletes).toBe('Its 12 tasks and their runs, its own goals, its AI budget and its workspace are deleted with it; its practices are retired.');
    expect(notice.moves).toBe('It owns no workflows, credentials, data tables or agents to move.');
    expect(deletionNotice({ counts: {}, taskCount: 1 }).deletes).toMatch(/^Its 1 task and their runs/);
    for (const text of Object.values(notice)) {
      expect(text).not.toMatch(/Nothing it owns is deleted/);
      expect(text).not.toMatch(/^It owns nothing\.$/);
    }
  });
  it('says what moves and still that tasks are deleted when it holds none', () => {
    const notice = deletionNotice({ counts: { workflow: 3, credential: 1 } });
    expect(notice.moves).toBe('What it owns (3 workflows, 1 credential) moves to the project you choose.');
    expect(notice.deletes).toBe('Its tasks, its own goals, its AI budget and its workspace are deleted with it; its practices are retired.');
  });
});
