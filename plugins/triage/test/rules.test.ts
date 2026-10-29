import { describe, expect, it } from 'vitest';
import { TriageRules } from '../src/nodes/triage-rules';
import { jsonOf, run } from './helpers';

const alert = (over: Record<string, unknown> = {}, labels: Record<string, string> = {}) => ({
  alert: { severity: 'sev3', title: 'Backup job failed', service: 'backup', labels: { alertname: 'BackupFailed', 'kubernetes.io/name': 'bk', ...labels }, tags: ['env:staging'], ...over },
});
const cond = (path: string, operator: string, value = '') => ({ path, operator, value });
const rule = (name: string, action: string, conditions: object[], extra: Record<string, unknown> = {}) => ({ name, action, match: 'all', conditions: { condition: conditions }, approvedBy: '', approvedAt: '', expiresAt: '', ...extra });
const rules = (...r: object[]): any => ({ rule: r });
const OUT = { bypass: 0, noise: 1, ask: 2, evaluate: 3 };

describe('Triage Rules', () => {
  it('bypasses sev1 before any rule, even a matching Noise rule', async () => {
    const noise = rule('All backup alerts', 'noise', [cond('alert.service', 'equals', 'backup')], { approvedBy: 'ana@example.com' });
    const response = await run(TriageRules, { rules: rules(noise) }, [alert({ severity: 'sev1' })]);
    expect(response.outputs.map((o) => o.length)).toEqual([1, 0, 0, 0]);
    expect(jsonOf(response, OUT.bypass)[0].triage).toMatchObject({ rule: { name: 'Severity bypass (sev1)', action: 'open', approvedBy: null } });
    expect(jsonOf(response, OUT.bypass)[0].triage.matchedAt).toMatch(/^\d{4}-/);
  });

  it('keeps sev1 bypassed even when the parameter is cleared, and bypasses other chosen severities', async () => {
    const noise = rule('All', 'noise', [cond('alert.service', 'exists')], { approvedBy: 'ana' });
    expect((await run(TriageRules, { rules: rules(noise), bypassSeverities: [] }, [alert({ severity: 'sev1' })])).outputs[0]).toHaveLength(1);
    expect((await run(TriageRules, { rules: rules(noise), bypassSeverities: ['sev1', 'sev2'] }, [alert({ severity: 'sev2' })])).outputs[0]).toHaveLength(1);
  });

  it('sends an unmatched alert to Evaluate untouched', async () => {
    const response = await run(TriageRules, { rules: rules(rule('x', 'ask', [cond('alert.service', 'equals', 'nope')])) }, [alert()]);
    expect(response.outputs.map((o) => o.length)).toEqual([0, 0, 0, 1]);
    expect(jsonOf(response, OUT.evaluate)[0].triage).toBeUndefined();
  });

  it('first matching rule wins, in order', async () => {
    const ask = rule('Ask first', 'ask', [cond('alert.title', 'contains', 'Backup')]);
    const noise = rule('Noise second', 'noise', [cond('alert.service', 'equals', 'backup')], { approvedBy: 'ana@example.com', approvedAt: '2026-10-01T00:00:00Z' });
    const a = await run(TriageRules, { rules: rules(ask, noise) }, [alert()]);
    expect(jsonOf(a, OUT.ask)[0].triage.rule).toEqual({ name: 'Ask first', action: 'ask', approvedBy: null });
    const b = await run(TriageRules, { rules: rules(noise, ask) }, [alert()]);
    expect(jsonOf(b, OUT.noise)[0].triage.rule).toEqual({ name: 'Noise second', action: 'noise', approvedBy: 'ana@example.com' });
    expect(b.outputs.map((o) => o.length)).toEqual([0, 1, 0, 0]);
  });

  it('an Always Open rule goes to Bypass', async () => {
    const r = rule('Payments always', 'open', [cond('alert.service', 'in', 'payments, backup')]);
    expect((await run(TriageRules, { rules: rules(r) }, [alert()])).outputs[0]).toHaveLength(1);
  });

  it('skips expired rules and names them', async () => {
    const expired = rule('Old noise', 'noise', [cond('alert.service', 'equals', 'backup')], { approvedBy: 'ana', expiresAt: '2020-01-01T00:00:00Z' });
    const live = rule('Future noise', 'noise', [cond('alert.service', 'equals', 'backup')], { approvedBy: 'bob', expiresAt: '2999-01-01T00:00:00Z' });
    const a = await run(TriageRules, { rules: rules(expired) }, [alert()]);
    expect(a.outputs.map((o) => o.length)).toEqual([0, 0, 0, 1]);
    expect(jsonOf(a, OUT.evaluate)[0].triage.expiredRules).toEqual(['Old noise']);
    const b = await run(TriageRules, { rules: rules(expired, live) }, [alert()]);
    expect(jsonOf(b, OUT.noise)[0].triage.rule.name).toBe('Future noise');
    const garbage = rule('Bad date', 'noise', [cond('alert.service', 'equals', 'backup')], { approvedBy: 'ana', expiresAt: 'someday' });
    expect((await run(TriageRules, { rules: rules(garbage) }, [alert()])).outputs[3]).toHaveLength(1);
  });

  it('refuses a Noise rule nobody approved', async () => {
    for (const approvedBy of ['', '  ', 'AI', 'llm', 'auto']) {
      const response = await run(TriageRules, { rules: rules(rule('Sneaky', 'noise', [cond('alert.service', 'exists')], { approvedBy })) }, [alert()]);
      expect(response.error?.message, approvedBy).toMatch(/person must approve noise rules/);
      expect(response.error?.message).toContain('Sneaky');
    }
  });

  it('refuses even when the unapproved Noise rule would not match, or is expired, or continueOnFail is on', async () => {
    const bad = rule('Idle', 'noise', [cond('alert.service', 'equals', 'zzz')], { expiresAt: '2020-01-01T00:00:00Z' });
    expect((await run(TriageRules, { rules: rules(bad) }, [alert()])).error?.message).toMatch(/person must approve/);
    expect((await run(TriageRules, { rules: rules(bad) }, [alert()], { continueOnFail: true })).error?.message).toMatch(/person must approve/);
  });

  it('supports every operator, Any/All, labels with dots and array fields', async () => {
    const ok = async (c: object, item = alert()) => (await run(TriageRules, { rules: rules(rule('r', 'ask', [c])) }, [item])).outputs[2].length === 1;
    expect(await ok(cond('alert.labels.alertname', 'equals', 'BackupFailed'))).toBe(true);
    expect(await ok(cond('alert.labels.alertname', 'equals', 'backupfailed'))).toBe(false);
    expect(await ok(cond('alert.labels.alertname', 'notEquals', 'Other'))).toBe(true);
    expect(await ok(cond('alert.labels.kubernetes.io/name', 'equals', 'bk'))).toBe(true);
    expect(await ok(cond('alert.title', 'contains', 'job'))).toBe(true);
    expect(await ok(cond('alert.title', 'regex', '^Backup .* failed$'))).toBe(true);
    expect(await ok(cond('alert.title', 'regex', '/^backup/i'))).toBe(true);
    expect(await ok(cond('alert.title', 'regex', '(['))).toBe(false);
    expect(await ok(cond('alert.service', 'in', '["backup","x"]'))).toBe(true);
    expect(await ok(cond('alert.tags', 'equals', 'env:staging'))).toBe(true);
    expect(await ok(cond('alert.title', 'exists'))).toBe(true);
    expect(await ok(cond('alert.nothing', 'notExists'))).toBe(true);
    expect(await ok(cond('alert.nothing', 'exists'))).toBe(false);
    const any = rule('any', 'ask', [cond('alert.service', 'equals', 'x'), cond('alert.title', 'contains', 'Backup')], { match: 'any' });
    expect((await run(TriageRules, { rules: rules(any) }, [alert()])).outputs[2]).toHaveLength(1);
    const all = rule('all', 'ask', [cond('alert.service', 'equals', 'x'), cond('alert.title', 'contains', 'Backup')]);
    expect((await run(TriageRules, { rules: rules(all) }, [alert()])).outputs[3]).toHaveLength(1);
  });

  it('a rule without conditions never matches', async () => {
    expect((await run(TriageRules, { rules: rules(rule('empty', 'noise', [], { approvedBy: 'ana' })) }, [alert()])).outputs[3]).toHaveLength(1);
  });

  it('routes each item on its own and keeps earlier triage fields', async () => {
    const r = rule('Staging', 'ask', [cond('alert.tags', 'contains', 'staging')]);
    const items = [alert(), alert({ tags: ['env:prod'] }), { ...alert({ severity: 'sev1' }), triage: { keep: true } }];
    const response = await run(TriageRules, { rules: rules(r) }, items);
    expect(response.outputs.map((o) => o.length)).toEqual([1, 0, 1, 1]);
    expect(jsonOf(response, 0)[0].triage).toMatchObject({ keep: true });
    expect(response.outputs[2][0].pairedItem).toEqual({ item: 0 });
    expect(response.outputs[3][0].pairedItem).toEqual({ item: 1 });
  });
});
