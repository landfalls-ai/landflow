/** The goal fields on workflow settings and teams, and the team member picker's options (docs/projects-and-goals.md, docs/agent-teams.md). */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentSummary } from '../src/lib/shared/agents';
import { memberOptions, NOT_AVAILABLE, optionLabel, type AvailableAgent } from '../src/components/agents/member-options';
import { TeamGoalField } from '../src/components/agents/team-builder';
import { WorkflowGoalField } from '../src/components/editor/settings-dialog';

const all = [
  { id: 'agt_triage1', name: 'Triage', role: 'Sorts tickets' },
  { id: 'agt_writer1', name: 'Release writer' },
  { id: 'agt_other1', name: 'Elsewhere' },
] as AgentSummary[];

// The contract's example answer (agent-availability-api.md).
const answer: AvailableAgent[] = [
  { id: 'agt_triage1', name: 'Triage', role: 'Sorts tickets', ownership: { projectName: 'Billing revamp', shared: false } },
  { id: 'agt_writer1', name: 'Release writer', ownership: { projectName: 'Operations', shared: true } },
];

describe('member options', () => {
  it('offers the available agents, labelling a shared one with its home project', () => {
    const options = memberOptions(all, answer);
    expect(options.map((o) => o.id)).toEqual(['agt_triage1', 'agt_writer1']);
    expect(options[0]?.note).toBeUndefined();
    expect(optionLabel(options[1]!)).toContain('Shared from Operations');
    expect(optionLabel(options[0]!)).toBe('Triage, Sorts tickets');
  });
  it('keeps a current member that is no longer available, labelled', () => {
    const options = memberOptions(all, answer, ['agt_other1', 'agt_triage1', '']);
    expect(options.map((o) => o.id)).toEqual(['agt_triage1', 'agt_writer1', 'agt_other1']);
    expect(options[2]?.note).toBe(NOT_AVAILABLE);
  });
  it('keeps a member whose agent is gone entirely', () => {
    expect(memberOptions(all, answer, ['agt_gone'])[2]).toMatchObject({ id: 'agt_gone', note: NOT_AVAILABLE });
  });
  it('falls back to every agent without an answer', () => {
    expect(memberOptions(all, undefined, ['agt_other1']).map((o) => o.id)).toEqual(['agt_triage1', 'agt_writer1', 'agt_other1']);
  });
});

describe('goal fields', () => {
  const goals = [{ id: 'goal_a', title: 'Ship billing', level: 'project', projectId: 'prj_1', status: 'active', children: [] }] as never;
  it('the workflow field offers the project goal as the empty choice', () => {
    const html = renderToStaticMarkup(createElement(WorkflowGoalField, { projectId: 'prj_1', onChange: () => undefined, goals }));
    expect(html).toContain('The project&#x27;s goal');
    expect(html).toContain('Ship\u00a0billing');
    expect(html).toContain('Empty: the project’s goal');
  });
  it('the team field is named Project goal and says which goal it picks', () => {
    const html = renderToStaticMarkup(createElement(TeamGoalField, { projectId: 'prj_1', value: 'goal_a', onChange: () => undefined, goals }));
    expect(html).toContain('Project goal');
    expect(html).toContain('The project&#x27;s goal');
    expect(html).toContain('Which of the project');
  });
});
