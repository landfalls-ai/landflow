/** The agent builder's three tabs: where old links land, the Abilities rows, the Add menus, the kagent card and the one publish state. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { normalizeConfig } from '../src/lib/server/agents/store';
import { LayersCard, rowSummary } from '../src/components/agents/layers-card';
import {
  abilityRows,
  BUILDER_TABS,
  CAPABILITY_MENU,
  mapLegacyTab,
  publishLabel,
  rowOfSection,
  showKagent,
  TRIGGER_MENU,
} from '../src/components/agents/tabs';

const source = (file: string) => readFileSync(join(import.meta.dirname, '..', 'src', 'components', 'agents', file), 'utf8');

describe('agent tabs', () => {
  it('has the three tabs', () => {
    expect([...BUILDER_TABS]).toEqual(['persona', 'abilities', 'activity']);
  });

  it('maps every older ?tab= value', () => {
    expect(mapLegacyTab(undefined)).toEqual({ tab: 'persona' });
    expect(mapLegacyTab('persona')).toEqual({ tab: 'persona' });
    expect(mapLegacyTab('build')).toEqual({ tab: 'persona' });
    expect(mapLegacyTab('abilities')).toEqual({ tab: 'abilities' });
    expect(mapLegacyTab('deploy')).toEqual({ tab: 'abilities', open: 'deploy' });
    expect(mapLegacyTab('safety')).toEqual({ tab: 'abilities', open: 'guardrails' });
    expect(mapLegacyTab('settings')).toEqual({ tab: 'abilities', open: 'guardrails' });
    expect(mapLegacyTab('sessions')).toEqual({ tab: 'activity', view: 'sessions' });
    expect(mapLegacyTab('evaluations')).toEqual({ tab: 'activity', view: 'evaluations' });
    expect(mapLegacyTab('activity', undefined, 'evaluations')).toEqual({ tab: 'activity', view: 'evaluations' });
    expect(mapLegacyTab('activity')).toEqual({ tab: 'activity', view: 'sessions' });
    expect(mapLegacyTab('nonsense')).toEqual({ tab: 'persona' });
  });

  it('a session id alone opens the Sessions view', () => {
    expect(mapLegacyTab(undefined, 'ses_1')).toEqual({ tab: 'activity', view: 'sessions' });
  });

  it('keeps the deep-link sections working', () => {
    expect(rowOfSection('section-model')).toBe('model');
    expect(rowOfSection('section-capabilities')).toBe('capabilities');
    expect(rowOfSection('section-guardrails')).toBe('guardrails');
    for (const id of ['section-router', 'section-cache', 'section-access']) expect(rowOfSection(id)).toBe('advanced');
    expect(rowOfSection('section-persona')).toBeUndefined();
  });

  it('shows the kagent card only with a kagent cluster credential, or an agent already deployed there', () => {
    expect(showKagent(undefined)).toBe(false);
    expect(showKagent([{ type: 'core.slackApi' }])).toBe(false);
    expect(showKagent([{ type: 'core.slackApi' }, { type: 'core.kagentApi' }])).toBe(true);
    expect(showKagent([], true)).toBe(true);
    expect(abilityRows(false)).not.toContain('deploy');
    expect(abilityRows(true)).toContain('deploy');
  });

  it('offers one Add capability menu and one Add trigger menu', () => {
    expect(CAPABILITY_MENU.map((i) => i.label)).toEqual(['Tool', 'Workflow', 'Sub-agent', 'MCP server', 'GitHub MCP', 'A2A agent', 'Knowledge base', 'Plugin', 'Skill']);
    expect(TRIGGER_MENU.map((i) => i.label)).toEqual(['Schedule', 'Telegram', 'Slack', 'Teams']);
    const caps = source('capabilities-card.tsx');
    expect(caps).toContain('Add capability');
    // The one menu: no row of buttons beside it.
    expect(caps.match(/<Button size="sm" variant="outline"/g) ?? []).toHaveLength(1);
    const triggers = source('triggers-card.tsx');
    expect(triggers).toContain('Add trigger');
    expect(triggers).not.toContain('border-dashed');
    expect(triggers).not.toContain('Run on a schedule</');
  });

  it('draws the Abilities navigation: each row closed, the open ones with their card', () => {
    const config = normalizeConfig({ name: 'Helper', model: { provider: 'ollama', model: 'llama3' } });
    const render = (open: string[]) =>
      renderToStaticMarkup(
        createElement(LayersCard, {
          agentId: 'a1',
          config,
          published: false,
          rows: abilityRows(false),
          open: new Set(open) as never,
          onToggle: () => undefined,
          children: (row: string) => createElement('div', { 'data-card': row }, `card ${row}`),
        }),
      );
    const closed = render([]);
    for (const label of ['Model', 'Capabilities', 'Triggers', 'Guardrails', 'Advanced']) expect(closed).toContain(label);
    expect(closed).not.toContain('Deploy');
    expect(closed).not.toContain('data-card');
    expect(closed).toContain('ollama · llama3');
    const opened = render(['model', 'advanced']);
    expect(opened).toContain('card model');
    expect(opened).toContain('card advanced');
    expect(opened).not.toContain('card triggers');
    expect(opened.match(/aria-expanded="true"/g)).toHaveLength(2);
  });

  it('says the publish state once, on the header button', () => {
    expect(publishLabel(undefined, true, 1)).toBe('Publish');
    expect(publishLabel({ version: 3 }, true, 4)).toBe('Publish v4');
    expect(publishLabel({ version: 3 }, false, 4)).toBe('Live v3');
    const builder = source('builder.tsx');
    for (const gone of ['Changes not published', '<Badge', 'Published v{', 'The draft has changes not published yet', 'Nowhere yet']) expect(builder).not.toContain(gone);
  });

  it('summarizes rows truthfully', () => {
    const cfg = (extra: object) => normalizeConfig({ name: 'H', model: { provider: 'ollama', model: 'llama3' }, ...extra });
    const plugin = cfg({ plugins: ['x@y'] });
    expect(rowSummary('capabilities', plugin, [], false)).toEqual({ state: 'done', detail: '1 plugin' });
    expect(rowSummary('capabilities', cfg({}), [], false).state).toBe('todo');
    const pub = rowSummary('deploy', plugin, [], true);
    expect(pub.state).toBe('todo');
    expect(pub.detail).toContain('Not deployed');
    expect(rowSummary('deploy', plugin, [], true, { name: 'helper' })).toEqual({ state: 'done', detail: 'On kagent · helper' });
    const html = renderToStaticMarkup(
      createElement(LayersCard, { agentId: 'a1', config: cfg({}), published: false, rows: abilityRows(false), open: new Set() as never, onToggle: () => undefined, children: () => null }),
    );
    expect(html).toContain('1 of 5 set up');
  });
});
