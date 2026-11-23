/** The Event subscriptions card (C19), server-rendered: a row per subscription with its state, what an admin and a viewer see, and the shown-once secret. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EventSubscriptionsCardView, SecretNotice } from '../src/components/projects/event-subscriptions-card';
import { subscriptionState, type EventSubscriptionView } from '../src/lib/shared/event-subscriptions';

const base: EventSubscriptionView = {
  id: 'evs_1', projectId: 'prj_1', name: 'Billing system', url: 'https://billing.example.com/hooks/landflow?token=abc', events: ['run.finished', 'run.failed'], workflowIds: null, nodeNames: [],
  includeOutput: false, ordered: true, enabled: true, disabledReason: null, createdAt: '2026-11-22T08:00:00.000Z', updatedAt: '2026-11-22T08:00:00.000Z', lastDelivery: { at: '2026-11-22T09:00:00.000Z', status: 200, ms: 40 },
  backlog: 0, dead: 0, lastError: null, oldestAgeSeconds: 0,
};
const rows: EventSubscriptionView[] = [
  base,
  { ...base, id: 'evs_2', name: 'Backlogged', backlog: 12, oldestAgeSeconds: 600 },
  { ...base, id: 'evs_3', name: 'Failing one', backlog: 2, lastError: 'The receiver answered HTTP 500: nope', lastDelivery: { at: '2026-11-22T09:00:00.000Z', status: 500, ms: 10, error: 'The receiver answered HTTP 500: nope' } },
  { ...base, id: 'evs_4', name: 'Gone one', enabled: false, disabledReason: 'The receiver answered 410 Gone' },
  { ...base, id: 'evs_5', name: 'Dead one', dead: 3, lastError: 'timeout' },
];
const render = (canEdit: boolean, subscriptions = rows) => renderToStaticMarkup(createElement(EventSubscriptionsCardView, { subscriptions, canEdit, projectId: 'prj_1' }));

describe('subscriptionState', () => {
  it('names each state', () => {
    expect(subscriptionState(rows[0]!)).toEqual({ tone: 'ok', label: 'Delivering' });
    expect(subscriptionState(rows[1]!)).toEqual({ tone: 'warn', label: 'Backlog 12' });
    expect(subscriptionState(rows[2]!).label).toBe('Failing: The receiver answered HTTP 500: nope');
    expect(subscriptionState(rows[3]!).label).toBe('Disabled: The receiver answered 410 Gone');
    expect(subscriptionState(rows[4]!)).toMatchObject({ tone: 'danger', label: '3 given up: timeout' });
  });
});

describe('the card', () => {
  it('shows a row per subscription with its state, host and events, and never the path or token', () => {
    const html = render(true);
    for (const name of ['Billing system', 'Backlogged', 'Failing one', 'Gone one', 'Dead one']) expect(html).toContain(name);
    expect(html).toContain('Delivering');
    expect(html).toContain('Backlog 12');
    expect(html).toContain('Failing: The receiver answered HTTP 500: nope');
    expect(html).toContain('Disabled: The receiver answered 410 Gone');
    expect(html).toContain('billing.example.com');
    expect(html).not.toContain('token=abc');
    expect(html).toContain('A run finishes');
  });

  it('gives an admin Add, Retry now, Send test, Edit and Delete', () => {
    const html = render(true);
    for (const text of ['Add subscription', 'Retry now', 'Send test', 'Edit', 'Delete']) expect(html).toContain(text);
  });

  it('gives a viewer the list only', () => {
    const html = render(false);
    expect(html).toContain('Billing system');
    for (const text of ['Add subscription', 'Retry now', 'Send test', '>Edit<', '>Delete<']) expect(html).not.toContain(text);
  });

  it('says what it is for when empty, and offers Add to an admin only', () => {
    expect(render(true, [])).toContain('No subscriptions yet');
    expect(render(true, [])).toContain('Add subscription');
    expect(render(false, [])).not.toContain('Add subscription');
  });

  it('stacks rows on a phone', () => {
    expect(render(true)).toContain('max-md:flex-col');
  });
});

describe('the secret notice', () => {
  it('says it is shown once and offers Copy', () => {
    const html = renderToStaticMarkup(createElement(SecretNotice, { secret: 'whsec_abc123' }));
    expect(html).toContain('whsec_abc123');
    expect(html).toMatch(/only (time|now)|shown once|won.t be shown again/i);
    expect(html).toContain('Copy');
  });
});
