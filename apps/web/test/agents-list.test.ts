/**
 * The Agents list rules and markup: the persona strip only with no agents, no filter chip for nothing, cards with a name,
 * a description and a status, the New agent dialog's three ways in, and the persona tab's folded card text and prompt.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Agent, AgentSummary } from '../src/lib/shared/agents';
import { AgentCard } from '../src/components/agents/agent-card';
import { showPersonaStrip, visibleFilters } from '../src/components/agents/list-rules';
import { NEW_AGENT_WAYS, NewAgentWays } from '../src/components/agents/new-agent-dialog';
import { CardTextFields, PromptPreview } from '../src/components/agents/persona-tab';

const summary = (patch: Partial<AgentSummary> = {}): AgentSummary =>
  ({
    id: 'a1',
    name: 'Docs editor',
    role: 'Editor for the docs team',
    description: 'Tidies drafts for the docs team',
    team: 'Docs',
    tones: ['Warm'],
    model: 'claude-sonnet',
    tools: 3,
    skills: 2,
    sessions: 7,
    channels: ['slack'],
    schedules: 1,
    kagent: 'v1',
    marketplace: { plugin: 'docs', marketplace: 'acme' },
    updatedAt: new Date().toISOString(),
    ...patch,
  }) as unknown as AgentSummary;

describe('showPersonaStrip', () => {
  it('shows only when there are no agents', () => {
    expect(showPersonaStrip([])).toBe(true);
    expect(showPersonaStrip([summary()])).toBe(false);
    expect(showPersonaStrip(undefined)).toBe(false);
  });
});

describe('visibleFilters', () => {
  const counts = (...n: number[]) => (['all', 'published', 'drafts', 'kagent', 'marketplace'] as const).map((k, i) => [k, n[i]] as const);
  it('hides chips with a count of 0', () => {
    expect(visibleFilters(counts(4, 3, 1, 0, 0))).toEqual(['all', 'published', 'drafts']);
  });
  it('shows no row when only All is left', () => {
    expect(visibleFilters(counts(2, 0, 0, 0, 0))).toEqual([]);
  });
  it('keeps the active filter so it can be cleared', () => {
    expect(visibleFilters(counts(2, 2, 0, 0, 0), 'kagent')).toEqual(['all', 'published', 'kagent']);
  });
});

describe('AgentCard', () => {
  const html = renderToStaticMarkup(createElement(AgentCard, { agent: summary({ publishedVersion: 2, draftChanged: true } as Partial<AgentSummary>), onSave: () => {}, onExport: () => {} }));
  it('shows the name, the description and the status', () => {
    expect(html).toContain('Docs editor');
    expect(html).toContain('Tidies drafts for the docs team');
    expect(html).toContain('Published v2');
    expect(html).toContain('Changes not published');
  });
  it('drops the role repeat, model, tools, sessions, channels and tones', () => {
    for (const gone of ['Editor for the docs team', 'claude-sonnet', 'tool', 'session', 'Slack', 'kagent', 'Warm', 'From docs']) expect(html).not.toContain(gone);
  });
  it('says Draft when nothing is published', () => {
    expect(renderToStaticMarkup(createElement(AgentCard, { agent: summary(), onSave: () => {}, onExport: () => {} }))).toContain('Draft');
  });
});

describe('New agent ways', () => {
  it('offers a persona, the Agent architect and a file', () => {
    expect(NEW_AGENT_WAYS.map((w) => w.id)).toEqual(['persona', 'ai', 'file']);
    const html = renderToStaticMarkup(createElement(NewAgentWays, { onPick: () => {} }));
    for (const label of ['From a persona', 'Design with AI', 'From a file']) expect(html).toContain(label);
  });
});

describe('persona tab', () => {
  it('folds the card text under a closed details', () => {
    const html = renderToStaticMarkup(createElement(CardTextFields, { description: 'x' }));
    expect(html).toMatch(/<details(?![^>]*\sopen)/);
    expect(html).toContain('Card text (optional)');
    expect(html).toContain('What I do');
  });

  const agent = { id: 'a1', name: 'Docs editor', published: undefined } as unknown as Agent;
  const config = { name: 'Docs editor', description: '', instructions: 'Be kind.', skills: [], tools: [], persona: { role: 'Editor' }, memory: {} } as never;
  const preview = (initiallyOpen?: boolean) => renderToStaticMarkup(createElement(PromptPreview, { agent, config, nextVersion: 1, testable: false, onTest: () => {}, onEdit: () => {}, initiallyOpen }));
  it('keeps the system prompt behind View prompt', () => {
    const closed = preview();
    expect(closed).toContain('View prompt');
    expect(closed).not.toContain('Be kind.');
    const open = preview(true);
    expect(open).toContain('Hide prompt');
    expect(open).toContain('Be kind.');
    expect(open).toContain('Edit');
  });
});
