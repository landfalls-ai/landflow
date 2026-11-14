import { describe, expect, it } from 'vitest';
import { validateWorkEvent, WORK_LIMITS, type WorkEventInput } from '../src';

const base: WorkEventInput = { kind: 'work.session', source: 'claude-code', sourceId: 'session-1', occurredAt: '2026-11-13T09:30:00.000Z', title: 'Fixed the retry loop in the billing worker' };
const errorsOf = (patch: Record<string, unknown>) => {
  const result = validateWorkEvent({ ...base, ...patch });
  return result.ok ? [] : result.errors;
};

describe('validateWorkEvent', () => {
  it('accepts a minimal event and a full one', () => {
    expect(validateWorkEvent(base)).toEqual({ ok: true, value: base });
    const full: WorkEventInput = {
      ...base,
      endedAt: '2026-11-13T10:15:00.000Z',
      summary: 'Backoff now caps at one minute.',
      repo: 'acme/billing',
      branch: 'fix/retry',
      areas: ['services/worker', 'docs'],
      commits: 3,
      prs: [{ url: 'https://github.com/acme/billing/pull/12', state: 'opened' }],
      turns: 14,
      initiative: 'Reliability',
      customer: 'Example Co',
      team: 'Platform',
      url: 'https://example.com/session/1',
      visibility: 'private',
    };
    expect(validateWorkEvent(full)).toEqual({ ok: true, value: full });
  });

  it('drops unknown fields', () => {
    const result = validateWorkEvent({ ...base, diff: '+ secret' });
    expect(result).toEqual({ ok: true, value: base });
  });

  it('needs the required fields', () => {
    const result = validateWorkEvent({});
    expect(result.ok).toBe(false);
    expect(errorsOf({ kind: undefined })).toContain('kind is required');
    expect(errorsOf({ title: '  ' })).toContain('title is required');
    expect(errorsOf({ occurredAt: 'yesterday' })).toContain('occurredAt must be an ISO 8601 time');
    expect(validateWorkEvent('text').ok).toBe(false);
  });

  it('checks the shapes', () => {
    expect(errorsOf({ kind: 'session' })[0]).toMatch(/work\.<name>/);
    expect(errorsOf({ source: 'Claude Code' })[0]).toMatch(/source/);
    expect(errorsOf({ repo: 'just-a-name' })[0]).toMatch(/owner\/name/);
    expect(errorsOf({ visibility: 'everyone' })[0]).toMatch(/visibility/);
    expect(errorsOf({ url: 'javascript:alert(1)' })[0]).toMatch(/url/);
    expect(errorsOf({ commits: -1 })[0]).toMatch(/commits/);
    expect(errorsOf({ turns: 1.5 })[0]).toMatch(/turns/);
    expect(errorsOf({ prs: [{ url: 'https://x.test/1', state: 'closed' }] })[0]).toMatch(/pull request/);
  });

  it('enforces each limit', () => {
    expect(errorsOf({ source: 'a'.repeat(WORK_LIMITS.source + 1) }).length).toBeGreaterThan(0);
    expect(errorsOf({ sourceId: 'x'.repeat(WORK_LIMITS.sourceId + 1) })[0]).toMatch(/sourceId/);
    expect(errorsOf({ title: 'x'.repeat(WORK_LIMITS.title + 1) })[0]).toMatch(/title/);
    expect(errorsOf({ summary: 'x'.repeat(WORK_LIMITS.summary + 1) })[0]).toMatch(/summary/);
    expect(errorsOf({ branch: 'x'.repeat(WORK_LIMITS.branch + 1) })[0]).toMatch(/branch/);
    expect(errorsOf({ team: 'x'.repeat(WORK_LIMITS.hint + 1) })[0]).toMatch(/team/);
    expect(errorsOf({ areas: Array.from({ length: WORK_LIMITS.areas + 1 }, (_, i) => `dir${i}`) })[0]).toMatch(/areas/);
    expect(errorsOf({ areas: ['d'.repeat(WORK_LIMITS.area + 1)] })[0]).toMatch(/areas|area/);
    const pr = { url: 'https://x.test/1', state: 'merged' as const };
    expect(errorsOf({ prs: Array.from({ length: WORK_LIMITS.prs + 1 }, () => pr) })[0]).toMatch(/prs/);
    expect(validateWorkEvent({ ...base, title: 'x'.repeat(WORK_LIMITS.title) }).ok).toBe(true);
  });

  it('rejects absolute paths and file names in areas', () => {
    expect(errorsOf({ areas: ['/Users/someone/project'] })[0]).toMatch(/absolute path/);
    expect(errorsOf({ areas: ['~/project'] })[0]).toMatch(/absolute path/);
    expect(errorsOf({ areas: ['C:\\work\\app'] })[0]).toMatch(/absolute path/);
    expect(errorsOf({ areas: ['src/app.ts'] })[0]).toMatch(/file name/);
    expect(errorsOf({ areas: ['README.md'] })[0]).toMatch(/file name/);
    expect(errorsOf({ areas: ['../outside'] })[0]).toMatch(/climbs/);
    expect(validateWorkEvent({ ...base, areas: ['src/lib', '.github', 'packages/engine'] }).ok).toBe(true);
  });

  it('rejects a long title that reads like code', () => {
    const code = 'function retry(job) { const wait = job.attempts * 2; return queue.push(job, wait); } export default retry;';
    expect(code.length).toBeGreaterThan(WORK_LIMITS.codeTitle);
    expect(errorsOf({ title: code })[0]).toMatch(/reads like code/);
    expect(errorsOf({ title: 'line one\nline two' })[0]).toMatch(/one line/);
    expect(validateWorkEvent({ ...base, title: 'Wrote a function to retry the job; it caps the wait' }).ok).toBe(true);
  });
});
