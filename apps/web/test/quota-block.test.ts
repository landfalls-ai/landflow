/** The Codex quota classifier (lib/shared/quota-block.ts): records, text, and what stays an ordinary error. */
import { describe, expect, it } from 'vitest';
import { BLOCKED_LABEL, classifyRecord, classifyText } from '@/lib/shared/quota-block';

const complete = (error: Record<string, unknown>) => ({ type: 'event_msg', payload: { type: 'task_complete', error } });

describe('classifyRecord', () => {
  it('reads usage_limit_exceeded as a usage limit', () => {
    expect(classifyRecord(complete({ message: 'out of credits', codex_error_info: 'usage_limit_exceeded' }))).toEqual({ blocked: true, kind: 'usage_limit', message: 'out of credits' });
  });

  it('says credits depleted when the preceding token_count named credits', () => {
    const verdict = classifyRecord(complete({ message: 'out', codex_error_info: 'usage_limit_exceeded' }), { rateLimitType: 'workspace_member_credits_depleted' });
    expect(verdict).toMatchObject({ blocked: true, kind: 'credits_depleted' });
  });

  it('reads a token_count record carrying the limit type', () => {
    const verdict = classifyRecord({ type: 'event_msg', payload: { type: 'token_count', rate_limit_reached_type: 'workspace_member_credits_depleted' } });
    expect(verdict).toMatchObject({ blocked: true, kind: 'credits_depleted' });
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
    expect(classifyText('Workspace credits depleted')).toMatchObject({ blocked: true, kind: 'credits_depleted' });
  });

  it('leaves ordinary failures alone', () => {
    for (const text of ['model not supported', 'rate limited by the gateway', 'the model is down', '', undefined]) expect(classifyText(text)).toEqual({ blocked: false });
  });

  it('labels each kind in words', () => {
    expect(BLOCKED_LABEL.usage_limit).toBe('Codex usage limit reached');
    expect(BLOCKED_LABEL.credits_depleted).toBe('Codex credits depleted');
    expect(BLOCKED_LABEL.unknown).toBe('Blocked by a provider limit');
  });
});
