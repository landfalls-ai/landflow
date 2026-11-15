/**
 * The agent screens' pure parts (PC07): the "Available in" line, the Test in project options and the dialog's checkboxes,
 * against the answers of the contract agent-availability-api (made-up ids and names).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AvailabilityForm } from '@/components/agents/availability-dialog';
import { ContextPreviewBody } from '@/components/agents/context-preview';
import {
  availabilityBody,
  availabilityLabel,
  canMakeAvailable,
  injectedText,
  previewUrl,
  sharedFromLabel,
  sharedIds,
  testProjectOptions,
  type AvailabilityAnswer,
} from '@/components/agents/project-names';

// The contract's example answer of GET /api/agents/:id/shares.
const example = {
  availability: { home: { id: 'prj_ops01', name: 'Operations' }, all: false, projects: [{ id: 'prj_billing01', name: 'Billing revamp' }] } satisfies AvailabilityAnswer,
  shares: [{ projectId: 'prj_billing01', projectName: 'Billing revamp', projectType: 'team', role: 'user', createdAt: '2026-11-16T09:00:00.000Z', createdBy: 'usr_owner1' }],
};
const home = example.availability.home;

describe('the Available in line', () => {
  it('names the home project and the others, two at most, then +N', () => {
    expect(availabilityLabel(undefined)).toBeUndefined();
    expect(availabilityLabel({ home, all: false, projects: [] })).toBe('Operations');
    expect(availabilityLabel(example.availability)).toBe('Operations, Billing revamp');
    expect(availabilityLabel({ home, all: false, projects: [{ id: 'p2', name: 'B' }, { id: 'p3', name: 'C' }, { id: 'p4', name: 'D' }] })).toBe('Operations, B +2');
  });
  it('says All projects for an all share', () => {
    expect(availabilityLabel({ home, all: true, projects: [] })).toBe('All projects');
  });
  it('says where a shared agent comes from, from the contract’s ownership', () => {
    expect(sharedFromLabel({ projectName: 'Operations', shared: true })).toBe('Shared from Operations');
    expect(sharedFromLabel({ projectName: 'Billing revamp', shared: false })).toBeUndefined();
  });
});

describe('Test in project', () => {
  it('offers the home first, then the available projects by name', () => {
    expect(testProjectOptions(undefined)).toEqual([]);
    expect(testProjectOptions({ home, all: false, projects: [{ id: 'p_z', name: 'Zed' }, { id: 'prj_billing01', name: 'Billing revamp' }, home] })).toEqual([home, { id: 'prj_billing01', name: 'Billing revamp' }, { id: 'p_z', name: 'Zed' }]);
  });
  it('offers every project the person sees for an all share', () => {
    const mine = [{ id: 'p_a', name: 'Alpha' }, home];
    expect(testProjectOptions({ home, all: true, projects: [] }, mine)).toEqual([home, { id: 'p_a', name: 'Alpha' }]);
  });
  it('builds the preview URL', () => {
    expect(previewUrl('agt_1')).toBe('/api/agents/agt_1/context-preview');
    expect(previewUrl('agt_1', 'prj a')).toBe('/api/agents/agt_1/context-preview?projectId=prj%20a');
  });
});

describe('the availability dialog', () => {
  it('only home admins change it', () => {
    expect(canMakeAvailable({ access: { role: 'admin', home: true } })).toBe(true);
    expect(canMakeAvailable({ access: { role: 'editor', home: true } })).toBe(false);
    expect(canMakeAvailable({ access: { role: 'admin', home: false } })).toBe(false);
    expect(canMakeAvailable(undefined)).toBe(true);
  });
  it('starts from every share but the home, and sends no home and no ids with all', () => {
    expect(sharedIds(example.shares, home.id)).toEqual(['prj_billing01']);
    expect(availabilityBody(['a', 'a', home.id, 'b'], false, home.id)).toEqual({ projectIds: ['a', 'b'], all: false });
    expect(availabilityBody(['a'], true, home.id)).toEqual({ projectIds: [], all: true });
  });
  const projects = [home, ...example.availability.projects, { id: 'prj_x', name: 'Elsewhere' }];
  const form = (extra: Partial<Parameters<typeof AvailabilityForm>[0]> = {}) =>
    renderToStaticMarkup(createElement(AvailabilityForm, { home, projects, selected: ['prj_billing01'], all: false, canEdit: true, onToggle: () => {}, onAll: () => {}, ...extra }));
  it('shows a checkbox per project and All projects', () => {
    const html = form();
    expect(html).toContain('Billing revamp');
    expect(html).toContain('Elsewhere');
    expect(html).toContain('All projects');
    expect(html.match(/type="checkbox"/g)).toHaveLength(4);
    expect(html).toContain('checked=""');
  });
  it('All projects disables the project checkboxes', () => {
    const html = form({ all: true });
    expect(html).toMatch(/<fieldset[^>]*disabled/);
  });
  it('is read-only for people who are not home admins', () => {
    expect(form({ canEdit: false })).toMatch(/<fieldset[^>]*disabled/);
    expect(form({ canEdit: false })).toContain('Only admins of the agent’s project change this.');
  });
  it('says how many shares to projects the person isn’t in are kept', () => {
    expect(form({ hidden: 2 })).toContain('Also shared with 2 projects you aren’t in');
  });
});

describe('the preview', () => {
  const practices = { text: '## Practices to follow\n- helm/chart-location', list: [{ handle: 'helm/chart-location', version: 2 }] };
  it('is the block, a blank line, then the practices', () => {
    expect(injectedText({ text: '## Where this work fits\nX', practices })).toBe('## Where this work fits\nX\n\n## Practices to follow\n- helm/chart-location');
    expect(injectedText({ text: '', practices })).toBe(practices.text);
    expect(injectedText({ text: '', practices: { text: '', list: [] } })).toBe('');
    expect(injectedText(undefined)).toBe('');
  });
  it('draws the text and the handles, or says there is nothing', () => {
    const html = renderToStaticMarkup(createElement(ContextPreviewBody, { preview: { mode: 'full', text: 'Block here', compact: '', practices } }));
    expect(html).toContain('Block here');
    expect(html).toContain('helm/chart-location@2');
    expect(renderToStaticMarkup(createElement(ContextPreviewBody, { preview: { mode: 'off', text: '', compact: '', practices: { text: '', list: [] } } }))).toContain('Nothing to add');
    expect(renderToStaticMarkup(createElement(ContextPreviewBody, { error: 'boom' }))).toContain('Couldn’t build the preview: boom');
  });
});
