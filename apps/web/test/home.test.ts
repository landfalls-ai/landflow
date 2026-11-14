/**
 * Home (docs/ux-simplification.md#home): one-line runs for a single flow, the Needs you tile in place of Plugins, the
 * offline-plugin line, the compact suggestion card, and no code left that branches on the retired Classic look.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { homeKpis, offlinePlugins, PluginsOfflineLine } from '../src/components/home/home-kpis';
import { ProposalCard, cardButtons, firstSentence, type ProposalActions } from '../src/components/brain/proposal-card';
import { isSingleFlow, RunLineRow } from '../src/components/run-trace/run-line';
import type { Proposal } from '../src/lib/shared/brain';
import type { RunLine } from '../src/lib/shared/run-line';
import type { PluginSummary } from '../src/lib/shared/types';

const flowLine: RunLine = { in: { label: 'Run by you', kind: 'manual' }, by: { members: [] }, out: { label: 'Done', tone: 'ok' }, status: 'done' as RunLine['status'], ms: 2300, tokens: 0 };
const agentLine: RunLine = { ...flowLine, by: { lead: { id: 'agent:a1', name: 'Billing agent', type: 'agent' } as NonNullable<RunLine['by']['lead']>, members: [] } };
const teamLine: RunLine = { ...flowLine, by: { members: [], team: 'Review team' } };

const row = (line: RunLine) => renderToStaticMarkup(createElement(RunLineRow, { line, name: 'Nightly sync', href: '/runs/ex_1', startedAt: new Date().toISOString() }));

describe('run rows on Home', () => {
  it('knows a single-flow run from an agent or team run', () => {
    expect(isSingleFlow(flowLine)).toBe(true);
    expect(isSingleFlow(agentLine)).toBe(false);
    expect(isSingleFlow(teamLine)).toBe(false);
  });

  it('draws a single-flow run as one line, the row being the link', () => {
    const html = row(flowLine);
    expect(html).toContain('Nightly sync');
    expect(html).toContain('href="/runs/ex_1"');
    expect(html).toContain('2.3 s');
    expect(html).not.toContain('Run by you');
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it('keeps the three-box card for an agent run', () => {
    const html = row(agentLine);
    expect(html).toContain('Run by you');
    expect(html).toContain('Billing agent');
  });
});

const plugin = (status: PluginSummary['status']) => ({ id: `p-${status}`, status }) as PluginSummary;

describe('Home tiles', () => {
  it('lists Needs you and no Plugins online', () => {
    const labels = homeKpis(undefined, 2).map((k) => k.label);
    expect(labels).toEqual(['Workflows', 'Executions (24h)', 'Failed (24h)', 'Needs you']);
    expect(labels).not.toContain('Plugins online');
    const needs = homeKpis(undefined, 2)[3]!;
    expect(needs.value).toBe(2);
    expect(needs.href).toBe('/executions?status=waiting');
    // Waiting is not failing: only the Failed tile draws its number in red.
    expect(needs.danger).toBeFalsy();
    expect(homeKpis({ workflows: 1, activeWorkflows: 1, executions24h: 4, failed24h: 1, avgDurationMs: 10 }, 2)[2]!.danger).toBe(true);
  });

  it('shows the offline line only when a plugin is offline', () => {
    expect(renderToStaticMarkup(createElement(PluginsOfflineLine, { count: offlinePlugins([plugin('online')]) }))).toBe('');
    const html = renderToStaticMarkup(createElement(PluginsOfflineLine, { count: offlinePlugins([plugin('online'), plugin('offline')]) }));
    expect(html).toContain('1 plugin offline');
    expect(html).toContain('Open Plugins');
    expect(html).toContain('href="/plugins"');
  });
});

const proposal = {
  id: 'pr_1',
  source: 'detector',
  detector: 'missing-tool',
  fingerprint: 'f',
  target: { type: 'workflow', name: 'Nightly sync' },
  title: 'Add a retry to Nightly sync',
  why: 'It failed three times this week. Each time the API timed out. A retry would have saved all three.',
  evidence: [{ label: 'Failed runs', value: '3' }],
  effect: 'About three fewer failures a week',
  ops: [],
  risk: 'low',
  confidence: 0.8,
  score: 1,
  status: 'open',
} as unknown as Proposal;
const actions: ProposalActions = { apply() {}, act() {}, dismiss() {}, snooze() {} };
const card = (expanded?: boolean) => renderToStaticMarkup(createElement(ProposalCard, { proposal, actions, expanded }));

describe('the compact suggestion card', () => {
  it('takes the first sentence as the why', () => {
    expect(firstSentence(proposal.why)).toBe('It failed three times this week.');
  });

  it('shows the title, one line of why, the apply button and the menu', () => {
    const html = card();
    expect(html).toContain('Add a retry to Nightly sync');
    expect(html).toContain('It failed three times this week.');
    expect(html).not.toContain('Each time the API timed out');
    expect(html).toContain('Build it');
    expect(html).toContain('aria-label="More: dismiss, snooze"');
    expect(html).toContain('Show more');
    for (const hidden of ['Failed runs', 'Low risk', '80% sure', 'Expected:']) expect(html).not.toContain(hidden);
  });

  it('keeps what the change leaves out in view, even folded', () => {
    const html = renderToStaticMarkup(createElement(ProposalCard, { proposal: { ...proposal, warnings: ['the Slack step without a channel'] } as Proposal, actions }));
    expect(html).toContain('Leaves the Slack step without a channel.');
    expect(html).not.toContain('Failed runs');
  });

  it('puts the flow’s buttons under ⋯, or the first in Apply’s place for advice', () => {
    const buttons = [
      { id: 'ship', label: 'Ship it', style: 'primary' as const },
      { id: 'later', label: 'Later' },
    ];
    const build = cardButtons({ ...proposal, actions: buttons } as Proposal);
    expect(build).toEqual({ hasApply: true, rest: buttons });
    const advice = cardButtons({ ...proposal, detector: 'quiet', ops: [], actions: buttons } as unknown as Proposal);
    expect(advice).toEqual({ hasApply: false, lead: buttons[0], rest: [buttons[1]] });
    const plain = cardButtons({ ...proposal, detector: 'quiet', ops: [] } as unknown as Proposal);
    expect(plain).toEqual({ hasApply: true, rest: [] });
    const html = renderToStaticMarkup(createElement(ProposalCard, { proposal: { ...proposal, detector: 'quiet', ops: [], actions: buttons } as unknown as Proposal, actions }));
    expect(html).toContain('Ship it');
    expect(html).not.toContain('Later');
    expect(html).not.toContain('Mark done');
  });

  it('shows the evidence, risk and what to expect once expanded', () => {
    const html = card(true);
    for (const shown of ['Failed runs', 'Low risk', '80% sure', 'Expected: About three fewer failures', 'Each time the API timed out', 'Show less']) expect(html).toContain(shown);
  });
});

describe('the Classic look', () => {
  it('is not branched on anywhere', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
    const src = join(import.meta.dirname, '..', 'src');
    const users = walk(src).filter((f) => /\.tsx?$/.test(f) && /\b(useNewLook|useLook|setLook)\b/.test(readFileSync(f, 'utf8')));
    expect(users).toEqual([]);
  });
});
