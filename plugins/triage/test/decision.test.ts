import { describe, expect, it } from 'vitest';
import { TriageDecision } from '../src/nodes/triage-decision';
import { jsonOf, run } from './helpers';

const verdict = (v: string, confidence: number | string, extra: Record<string, unknown> = {}) => ({ verdict: v, confidence, reasons: ['why'], ...extra });
const item = (v: unknown, extra: Record<string, unknown> = {}, severity = 'sev2') => ({
  alert: { severity, title: 'Disk full', service: 'db', dedupKey: 'prometheus:abc' },
  ...(v === undefined ? {} : { verdict: v }),
  ...extra,
});
const ROOM = { group: { dedupKey: 'prometheus:room-1' } };
const OPEN = 0, ATTACH = 1, ASK = 2;
const enforce = { mode: 'enforce' };

async function decide(input: object, params: Record<string, any> = enforce) {
  const response = await run(TriageDecision, params as any, [input as any]);
  const counts = response.outputs.map((o) => o.length);
  const at = counts.indexOf(1);
  return { response, at, triage: at >= 0 ? (jsonOf(response, at)[0].triage as any) : undefined, counts };
}

describe('Triage Decision: Enforce', () => {
  it('has exactly three outputs and no noise output', () => {
    expect(TriageDecision.description.outputs.map((o) => o.displayName)).toEqual(['Open', 'Attach', 'Ask']);
  });

  it('real opens a room', async () => {
    const d = await decide(item(verdict('real', 0.95, { summary: 'Disk is filling fast' })));
    expect(d.at).toBe(OPEN);
    expect(d.triage).toMatchObject({ outcome: 'open', mode: 'enforce', verdict: 'real', confidence: 0.95, policy: 'v1', dedupKey: 'prometheus:abc' });
    expect(d.triage.shadowOutcome).toBeUndefined();
    expect(d.triage.decidedAt).toMatch(/^\d{4}-/);
    expect(d.triage.summary).toContain('Disk full');
    expect(d.triage.summary).toContain('Disk is filling fast');
  });

  it('real with an open room attaches, and the dedup key is the room key', async () => {
    const d = await decide(item(verdict('real', 0.9), ROOM));
    expect(d.at).toBe(ATTACH);
    expect(d.triage.dedupKey).toBe('prometheus:room-1');
  });

  it('duplicate attaches with a room key, opens without one', async () => {
    expect((await decide(item(verdict('duplicate', 0.9), ROOM))).at).toBe(ATTACH);
    const d = await decide(item(verdict('duplicate', 0.9)));
    expect(d.at).toBe(OPEN);
    expect(d.triage.dedupKey).toBe('prometheus:abc');
  });

  it('unsure asks, whatever the confidence', async () => {
    expect((await decide(item(verdict('unsure', 0.99)))).at).toBe(ASK);
  });

  it('confidence below the minimum asks, and the minimum is a parameter', async () => {
    expect((await decide(item(verdict('real', 0.69)))).at).toBe(ASK);
    expect((await decide(item(verdict('real', 0.7)))).at).toBe(OPEN);
    expect((await decide(item(verdict('real', 0.5)), { ...enforce, minConfidence: 0.4 })).at).toBe(OPEN);
    expect((await decide(item(verdict('duplicate', 0.2), ROOM))).at).toBe(ASK);
  });

  it('AI noise asks and is never dropped', async () => {
    for (const confidence of [0.99, 0.5, 1]) {
      const d = await decide(item(verdict('noise', confidence)));
      expect(d.at).toBe(ASK);
      expect(d.triage.outcome).toBe('ask');
      expect(d.triage.reasons.join(' ')).toMatch(/only a rule a person approved/);
      expect(d.counts.reduce((a, b) => a + b, 0)).toBe(1);
    }
  });

  it('sev1 always opens, even for a confident noise or duplicate verdict', async () => {
    for (const v of [verdict('noise', 0.99), verdict('duplicate', 0.99), verdict('unsure', 0.1), 'garbage', undefined]) {
      const d = await decide(item(v, ROOM, 'sev1'));
      expect(d.at, JSON.stringify(v)).toBe(OPEN);
      expect(d.triage.reasons[0]).toMatch(/sev1 is never held/);
    }
  });
});

describe('Triage Decision: fail open', () => {
  it.each([
    ['missing verdict', undefined, /no verdict found/],
    ['garbage text', 'the alert looks fine to me', /not valid JSON/],
    ['invalid JSON', '{"verdict": "real", ', /not valid JSON/],
    ['unknown verdict', verdict('maybe', 0.9), /unknown verdict "maybe"/],
    ['missing confidence', { verdict: 'noise' }, /confidence is missing/],
    ['confidence out of range', verdict('noise', 85), /confidence is missing or not a number between 0 and 1/],
    ['non-numeric confidence', verdict('noise', 'high'), /confidence/],
    ['a number', 42, /not valid JSON/],
    ['an empty object', {}, /unknown verdict/],
  ])('%s opens a room', async (_name, v, reason) => {
    const d = await decide(item(v as any, ROOM));
    expect(d.at).toBe(OPEN);
    expect(d.triage.reasons[0]).toMatch(/^fail open: /);
    expect(d.triage.reasons[0]).toMatch(reason as RegExp);
    expect(d.triage.failedOpen).toBe(true);
    expect(d.triage.verdict).toBeNull();
  });
});

describe('Triage Decision: verdict parsing', () => {
  it('accepts JSON text, fenced JSON and JSON in prose', async () => {
    const json = JSON.stringify(verdict('real', 0.9, { suggestedSeverity: 'sev1' }));
    for (const text of [json, '```json\n' + json + '\n```', '```\n' + json + '\n```', `Here is my verdict:\n\`\`\`json\n${json}\n\`\`\`\nHope it helps.`, `Verdict: ${json} done`]) {
      const d = await decide(item(text));
      expect(d.at).toBe(OPEN);
      expect(d.triage).toMatchObject({ verdict: 'real', confidence: 0.9, suggestedSeverity: 'sev1' });
      expect(d.triage.failedOpen).toBeUndefined();
    }
  });

  it('falls back to the output field, and unwraps nested output', async () => {
    const fenced = '```json\n' + JSON.stringify(verdict('duplicate', 0.88)) + '\n```';
    expect((await decide({ ...item(undefined, ROOM), output: fenced })).at).toBe(ATTACH);
    expect((await decide(item({ output: fenced }, ROOM))).at).toBe(ATTACH);
    expect((await decide(item({ verdict: verdict('duplicate', 0.88) }, ROOM))).at).toBe(ATTACH);
    expect((await decide({ ...item(undefined), result: { verdict: verdict('unsure', 0.9) } }, enforce)).at).toBe(OPEN);
  });

  it('reads another verdict field and room field, and accepts string reasons and upper-case verdicts', async () => {
    const input = { alert: { severity: 'sev3', dedupKey: 'k' }, ai: { answer: { verdict: 'REAL', confidence: '0.9', reasons: 'one reason' } }, open: { key: 'room-9' } };
    const d = await decide(input, { ...enforce, verdictField: 'ai.answer', existingRoomField: 'open.key' });
    expect(d.at).toBe(ATTACH);
    expect(d.triage).toMatchObject({ dedupKey: 'room-9', reasons: expect.any(Array) });
  });

  it('uses the severity field parameter', async () => {
    const input = { sev: 'sev1', verdict: verdict('noise', 0.99) };
    expect((await decide(input, { ...enforce, severityField: 'sev' })).at).toBe(OPEN);
    expect((await decide(input, enforce)).at).toBe(ASK);
  });
});

describe('Triage Decision: Shadow', () => {
  it('opens a room for everything and records what Enforce would have done', async () => {
    const cases: Array<[unknown, Record<string, unknown>, string]> = [
      [verdict('real', 0.9), {}, 'open'],
      [verdict('real', 0.9), ROOM, 'attach'],
      [verdict('duplicate', 0.9), ROOM, 'attach'],
      [verdict('noise', 0.99), {}, 'ask'],
      [verdict('unsure', 0.5), {}, 'ask'],
      [verdict('real', 0.3), {}, 'ask'],
      ['garbage', {}, 'open'],
    ];
    for (const [v, extra, expected] of cases) {
      const d = await decide(item(v, extra), { mode: 'shadow' });
      expect(d.at, JSON.stringify(v)).toBe(OPEN);
      expect(d.triage).toMatchObject({ outcome: 'open', mode: 'shadow', shadowOutcome: expected });
    }
  });

  it('is the default mode', async () => {
    const d = await decide(item(verdict('noise', 0.99)), {});
    expect(d.at).toBe(OPEN);
    expect(d.triage).toMatchObject({ mode: 'shadow', shadowOutcome: 'ask' });
    expect(d.triage.summary).toContain('shadow mode');
  });

  it('shadow attach keeps the real alert key as the dedup key (no room is joined)', async () => {
    const d = await decide(item(verdict('duplicate', 0.9), ROOM), { mode: 'shadow' });
    expect(d.triage.dedupKey).toBe('prometheus:abc');
  });
});

describe('Triage Decision: items', () => {
  it('routes items independently, keeps earlier triage fields and pairs items', async () => {
    const items = [item(verdict('real', 0.9), { triage: { rule: { name: 'r' } } }), item(verdict('duplicate', 0.9), ROOM), item(verdict('noise', 0.9))];
    const response = await run(TriageDecision, enforce as any, items as any);
    expect(response.outputs.map((o) => o.length)).toEqual([1, 1, 1]);
    expect(jsonOf(response, 0)[0].triage.rule).toEqual({ name: 'r' });
    expect(response.outputs[2][0].pairedItem).toEqual({ item: 2 });
  });
});
