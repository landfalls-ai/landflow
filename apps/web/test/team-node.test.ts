/**
 * The Run a Team node in the editor's new look (lib/shared/team-node.ts, components/editor/team-node-panel.tsx): how the
 * panel splits the node's fields, the team card's words, who the lead asks, the roster row and the last run in a few
 * words; and the panel with no team chosen, rendered to static HTML.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PropertyDescriptor } from '@landflow/protocol';
import type { AgentTeamConfig } from '../src/lib/shared/agent-teams';
import { approvalChoiceLabel, lastRunWords, leadAsks, rosterText, teamCardLine, teamPanelFields, teamVersion } from '../src/lib/shared/team-node';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }), usePathname: () => '/' }));

const properties = [
  { name: 'teamId', displayName: 'Team', type: 'options', default: '', required: true, typeOptions: { loadOptionsMethod: 'teams' } },
  { name: 'teamName', displayName: 'Team Name', type: 'hidden', default: '' },
  { name: 'message', displayName: 'Message', type: 'string', default: '{{ $json.chatInput }}', required: true },
  { name: 'version', displayName: 'Version', type: 'options', default: 'published', options: [{ name: 'Published', value: 'published' }, { name: 'Draft', value: 'draft' }] },
  {
    name: 'approvalChannel',
    displayName: 'Ask For Tool Approvals In',
    type: 'options',
    default: 'chat',
    options: [
      { name: 'Chat / Execution View', value: 'chat', description: 'Approve or Deny buttons on the node' },
      { name: 'Slack', value: 'slack' },
      { name: 'Email', value: 'email' },
    ],
  },
  { name: 'slackChannel', displayName: 'Slack Channel', type: 'string', default: '', displayOptions: { show: { approvalChannel: ['slack'] } } },
  { name: 'approvalTimeoutMinutes', displayName: 'Approval Timeout (Minutes)', type: 'number', default: 0 },
  { name: 'notice', displayName: 'The lead runs with the team’s goal…', type: 'notice' },
] as unknown as PropertyDescriptor[];

const config: AgentTeamConfig = {
  name: 'Tech Lead team',
  members: [
    { id: 'm_lead', kind: 'agent', agentId: 'ag_lead', title: 'Tech Lead' },
    { id: 'm_plan', kind: 'agent', agentId: 'ag_plan', title: 'Planner', reportsTo: 'm_lead' },
    { id: 'm_dev', kind: 'agent', agentId: 'ag_dev', title: 'Developer', reportsTo: 'm_lead' },
    { id: 'm_rev', kind: 'agent', agentId: 'ag_rev', title: 'Reviewer', reportsTo: 'm_dev' },
  ],
};

describe('the team panel’s fields', () => {
  it('takes the team, its name, the approvals and the notice out of the form, and names the rest plainly', () => {
    const fields = teamPanelFields(properties);
    expect(fields.ask.map((p) => p.displayName)).toEqual(['What to ask the lead', 'Which version']);
    expect(fields.approvals?.name).toBe('approvalChannel');
    expect(fields.rest.map((p) => p.name)).toEqual(['slackChannel', 'approvalTimeoutMinutes']);
    expect(fields.rest[1].displayName).toBe('How long to wait (minutes)');
    expect(fields.notice).toContain('The lead runs');
    // The node's own descriptor is left as it was.
    expect(properties[2].displayName).toBe('Message');
  });

  it('says where approvals go in a person’s words', () => {
    expect(approvalChoiceLabel({ name: 'Chat / Execution View', value: 'chat' })).toBe('Here and in Needs you');
    expect(approvalChoiceLabel({ name: 'Slack', value: 'slack' })).toBe('Slack');
  });
});

describe('the team card and the node', () => {
  it('says the version and the size, or what stops it from running', () => {
    expect(teamCardLine({ members: 4, published: { version: 3, publishedAt: '' } })).toBe('Published v3 · lead and 3 members');
    expect(teamCardLine({ members: 2, published: { version: 1, publishedAt: '' } })).toBe('Published v1 · lead and 1 member');
    expect(teamCardLine({ members: 1, published: undefined })).toBe('Not published yet: publish it on its page to run it');
    expect(teamCardLine({ members: 3, published: undefined }, 'draft')).toBe('Draft · lead and 2 members');
  });

  it('runs the published version unless the node says draft', () => {
    const team = { id: 't', draft: { ...config, name: 'Draft name' }, published: { ...config, version: 2, publishedAt: '' }, createdAt: '', updatedAt: '' };
    expect(teamVersion(team, 'published')?.name).toBe('Tech Lead team');
    expect(teamVersion(team, 'draft')?.name).toBe('Draft name');
    expect(teamVersion({ ...team, published: undefined }, 'published')).toBeUndefined();
  });

  it('names who the lead asks directly, not the members under them', () => {
    const { lead, asks } = leadAsks(config);
    expect(lead?.title).toBe('Tech Lead');
    expect(asks.map((m) => m.title)).toEqual(['Planner', 'Developer']);
  });

  it('lists the members after the lead, with a count past the room', () => {
    expect(rosterText(['Planner', 'Developer', 'Reviewer'])).toBe('Planner · Developer · Reviewer');
    expect(rosterText(['A', 'B', 'C', 'D', 'E', 'F'])).toBe('A · B · C · D +2');
  });

  it('tells the last run in a few words', () => {
    const members = [{ tokens: 12_000 }, { tokens: 10_000 }];
    expect(lastRunWords({ status: 'success', durationMs: 145_000, members }, 'Answered')).toBe('Answered · 2m 25s · 22k tokens');
    expect(lastRunWords({ status: 'error', durationMs: 4_000, members: [] })).toBe('Failed · 4.0 s');
    expect(lastRunWords({ status: 'running', live: true, members })).toBe('Running now · 22k tokens');
  });
});

describe('the panel with no team chosen', () => {
  it('asks to choose a team, then the message, the approval choices and the rest of the form', async () => {
    const { TeamNodePanel } = await import('../src/components/editor/team-node-panel');
    const html = renderToStaticMarkup(createElement(TeamNodePanel, { properties, values: { teamId: '', approvalChannel: 'chat' }, onChange: () => {}, form: {} }));
    expect(html).toContain('Team · choose one');
    expect(html).toContain('What to ask the lead');
    expect(html).toContain('When a member needs a person');
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>Here and in Needs you<\/button>/);
    expect(html).toMatch(/role="radio" aria-checked="false"[^>]*>Slack<\/button>/);
    expect(html).toContain('How long to wait (minutes)');
    // Not the old dropdown, nor the block of text.
    expect(html).not.toContain('Ask For Tool Approvals In');
    expect(html).not.toContain('The lead runs with');
    expect(html).not.toContain('Who is on it');
  });
});
