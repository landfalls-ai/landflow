/** The Codex quota classifier (packages/protocol/src/quota-block.ts, C08): records, text, and what stays an ordinary error. */
import { describe, expect, it } from 'vitest';
import { BLOCKED_LABEL, classifyRecord, classifyText } from '../src/quota-block';

const complete = (error: Record<string, unknown>) => ({ type: 'event_msg', payload: { type: 'task_complete', error } });

describe('classifyRecord', () => {
  it('reads usage_limit_exceeded as a usage limit', () => {
    expect(classifyRecord(complete({ message: 'out of credits', codex_error_info: 'usage_limit_exceeded' }))).toEqual({ blocked: true, kind: 'usage_limit', message: 'out of credits', label: 'Codex usage limit reached' });
  });

  it('says credits depleted when the preceding token_count named credits', () => {
    const verdict = classifyRecord(complete({ message: 'out', codex_error_info: 'usage_limit_exceeded' }), { rateLimitType: 'workspace_member_credits_depleted' });
    expect(verdict).toMatchObject({ blocked: true, kind: 'credits_depleted' });
  });

  it('reads a token_count record carrying the limit type', () => {
    const verdict = classifyRecord({ type: 'event_msg', payload: { type: 'token_count', rate_limit_reached_type: 'workspace_member_credits_depleted' } });
    expect(verdict).toMatchObject({ blocked: true, kind: 'credits_depleted' });
  });

  it('reads the nested rate_limits shape of a token_count, as Codex writes it', () => {
    const verdict = classifyRecord({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { rate_limit_reached_type: 'workspace_member_credits_depleted' } } });
    expect(verdict).toMatchObject({ blocked: true, kind: 'credits_depleted', label: 'Codex credits depleted' });
    expect(classifyRecord({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { rate_limit_reached_type: 'primary' } } })).toEqual({ blocked: false });
  });

  it('does not count a limit-type value that names no limit', () => {
    expect(classifyRecord({ rate_limit_reached_type: 'primary' })).toEqual({ blocked: false });
  });

  it('reads OpenAI insufficient_quota as credits depleted, in neutral words', () => {
    expect(classifyRecord({ error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } })).toEqual({ blocked: true, kind: 'credits_depleted', message: 'You exceeded your current quota', label: 'Credits depleted' });
    expect(classifyRecord({ error: { type: 'insufficient_quota' } })).toMatchObject({ blocked: true, kind: 'credits_depleted' });
    expect(classifyRecord({ error: { code: 'rate_limit_exceeded', message: 'Rate limit reached for gpt' } })).toEqual({ blocked: false });
  });

  it('treats any other codex_error_info as an ordinary error', () => {
    expect(classifyRecord(complete({ message: 'x', codex_error_info: 'other' }))).toEqual({ blocked: false });
  });

  it('is not blocked for a record without an error, or a value that is no record', () => {
    expect(classifyRecord({ type: 'event_msg', payload: { type: 'task_complete' } })).toEqual({ blocked: false });
    expect(classifyRecord(null)).toEqual({ blocked: false });
    expect(classifyRecord('text')).toEqual({ blocked: false });
  });

  it('reads the bare error shape an A2A status data part carries', () => {
    expect(classifyRecord({ codex_error_info: 'usage_limit_exceeded', rate_limit_reached_type: 'workspace_member_credits_depleted' })).toMatchObject({ blocked: true, kind: 'credits_depleted' });
  });

  it('cuts the message at 500 characters', () => {
    const verdict = classifyRecord(complete({ message: 'x'.repeat(900), codex_error_info: 'usage_limit_exceeded' }));
    expect(verdict.blocked && verdict.message.length).toBe(500);
  });
});

describe('classifyText', () => {
  it('matches the usage-limit and credit phrases', () => {
    expect(classifyText("You've hit your usage limit")).toMatchObject({ blocked: true, kind: 'usage_limit' });
    expect(classifyText('usage_limit_exceeded')).toMatchObject({ blocked: true, kind: 'usage_limit' });
    expect(classifyText('You are out of credits')).toMatchObject({ blocked: true, kind: 'credits_depleted' });
    expect(classifyText('You exceeded your current quota, please check your plan')).toMatchObject({ blocked: true, kind: 'credits_depleted' });
    expect(classifyText('Your credit balance is too low to access the API')).toMatchObject({ blocked: true, kind: 'credits_depleted' });
    expect(classifyText('Usage limit reached for this plan')).toMatchObject({ blocked: true, kind: 'usage_limit' });
    expect(classifyText('Workspace credits depleted')).toMatchObject({ blocked: true, kind: 'credits_depleted' });
  });

  it('leaves ordinary failures alone', () => {
    for (const text of [
      'model not supported',
      'rate limited by the gateway',
      'Rate limit reached for gpt-5 in organization org-1',
      '429 Too Many Requests',
      'the model is down',
      'Container exceeded its memory usage limit',
      'CPU usage limit exceeded',
      'Disk usage limit of 10GB reached',
      'No usage limit is set for this project',
      '',
      undefined,
    ]) expect(classifyText(text)).toEqual({ blocked: false });
  });

  it('uses neutral words for a text verdict', () => {
    expect(classifyText("You've hit your usage limit")).toMatchObject({ label: 'Usage limit reached' });
    expect(classifyText('out of credits')).toMatchObject({ label: 'Credits depleted' });
  });

  it('labels each kind in words', () => {
    expect(BLOCKED_LABEL.usage_limit).toBe('Codex usage limit reached');
    expect(BLOCKED_LABEL.credits_depleted).toBe('Codex credits depleted');
    expect(BLOCKED_LABEL.unknown).toBe('Blocked by a provider limit');
  });
});

describe('the module', () => {
  it('imports nothing and is reachable through the protocol barrel and its subpath', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(new URL('../src/quota-block.ts', import.meta.url), 'utf8')).not.toMatch(/^import /m);
    const barrel = await import('../src/index');
    expect(barrel.classifyText).toBe(classifyText);
  });
});
