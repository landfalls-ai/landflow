/**
 * An options field with nothing chosen says so ("Choose a team…") instead of drawing its first option, which looked
 * chosen but was not saved: a new Run a Team node showed a team in its panel, kept `teamId: ""`, and picking that team
 * changed nothing.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PropertyDescriptor } from '@landflow/protocol';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }), usePathname: () => '/' }));
const { ParamForm, choosePrompt } = await import('../src/components/editor/param-form');

const team = { name: 'teamId', displayName: 'Team', type: 'options', required: true, default: '', typeOptions: { loadOptionsMethod: 'teams' } } as unknown as PropertyDescriptor;
const mode = { name: 'mode', displayName: 'Operation', type: 'options', default: '', options: [{ name: 'Send', value: 'send' }, { name: 'Read', value: 'read' }] } as unknown as PropertyDescriptor;
const render = (properties: PropertyDescriptor[], values: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(ParamForm, { nodeType: 'core.runTeam', properties, values, onChange: () => {} }));

describe('an options field with nothing chosen', () => {
  it('says what to choose, with an article that fits', () => {
    expect(choosePrompt({ displayName: 'Team' })).toBe('Choose a team…');
    expect(choosePrompt({ displayName: 'Operation' })).toBe('Choose an operation…');
    expect(choosePrompt({ displayName: 'Team', placeholder: 'Pick the team to run' })).toBe('Pick the team to run');
  });

  it('shows the prompt, selected and not choosable, instead of the first option', () => {
    const html = render([team, mode], { teamId: '', mode: '' });
    expect(html).toContain('<option value="" disabled="" selected="">Choose a team…</option>');
    expect(html).toContain('<option value="" disabled="" selected="">Choose an operation…</option>');
  });

  it('shows no prompt once something is chosen', () => {
    const html = render([mode], { mode: 'read' });
    expect(html).not.toContain('Choose an operation…');
    expect(html).toContain('<option value="read" selected="">Read</option>');
  });
});
