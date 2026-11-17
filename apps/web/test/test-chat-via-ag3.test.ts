// @vitest-environment happy-dom
/**
 * Wave ag3 carryover (the live pass, triage agent): the agent page's Test chat folds settled tool calls into one activity
 * line, and its steps showed only the output: no "via" line, though the session's timeline held each call's target (the
 * waiting approval card showed it). Each step now says where the call went, from the same target, and never more.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { toolStep } from '@/components/agents/timeline';
import { ActivityTrace } from '@/components/ui/activity-trace';

const entry = (target?: Record<string, unknown>) =>
  ({ type: 'tool', id: 't1', callId: 'c1', at: '2026-11-17T20:00:00.000Z', tool: 'send_email', label: 'send_email', kind: 'node', status: 'success', durationMs: 23, output: { accepted: ['oncall@landflow.test'] }, ...(target && { target }) }) as never;

describe("the Test chat's steps say what each call reached", () => {
  it('a step carries the target line; one without a target carries none', () => {
    expect(toolStep(entry({ name: 'Mailpit SMTP', system: 'SMTP', endpoint: '127.0.0.1:51188', credentialId: 'cred_x' })).via).toBe('Mailpit SMTP · SMTP 127.0.0.1:51188');
    expect(toolStep(entry({ name: 'triage plugin', system: 'Normalize Alert', plugin: { id: 'triage', endpoint: '127.0.0.1:7798' } })).via).toMatch(/^triage plugin/);
    expect(toolStep(entry()).via).toBeUndefined();
  });

  it('the opened activity line shows "via …" under the step, with no credential id', () => {
    const step = toolStep(entry({ name: 'Mailpit SMTP', system: 'SMTP', endpoint: '127.0.0.1:51188', credentialId: 'cred_x' }));
    const html = renderToStaticMarkup(createElement(ActivityTrace, { steps: [step], live: false, durationMs: 23, defaultOpen: true }));
    expect(html).toContain('via Mailpit SMTP · SMTP 127.0.0.1:51188');
    expect(html).not.toContain('cred_x');
  });
});
