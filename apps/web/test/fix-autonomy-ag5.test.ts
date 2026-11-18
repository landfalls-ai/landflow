/**
 * AG22: the contract of wave ag5 (lib/shared/fix-autonomy.ts): the rule for a test-and-fix session, the destinations Spotlight may
 * approve, the credential it picks alone, and the lines it says. The copy equals backbone/contracts/ag5/fix-autonomy.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  approvedByLine,
  AUTO_FIX_DOES,
  AUTO_FIX_NEVER,
  fixAutonomyFor,
  keptOwnFixLine,
  normalDestination,
  pickAlone,
  pickedAloneLine,
  publishedLine,
  spotlightMayApprove,
  unattendedLine,
} from '@/lib/shared/fix-autonomy';

// The pipeline's contracts folder lives outside the repository: set LANDFLOW_BACKBONE_CONTRACTS to it to check the copy.
const CONTRACTS = process.env.LANDFLOW_BACKBONE_CONTRACTS ?? '';

describe('the contract copy', () => {
  it.skipIf(!CONTRACTS)('equals contracts/ag5/fix-autonomy.ts byte for byte', () => {
    const copy = readFileSync(join(__dirname, '../src/lib/shared/fix-autonomy.ts'));
    expect(copy.equals(readFileSync(join(CONTRACTS, 'ag5/fix-autonomy.ts')))).toBe(true);
  });
});

describe('fixAutonomyFor', () => {
  it('is the switch alone: a saved or published workflow no longer forces asks-first', () => {
    expect(fixAutonomyFor({ switchOn: true })).toBe('auto');
    expect(fixAutonomyFor({ switchOn: false })).toBe('asks-first');
  });
  it('lists what it does and what stays', () => {
    expect(AUTO_FIX_DOES.length).toBeGreaterThanOrEqual(6);
    expect(AUTO_FIX_NEVER.join(' ')).toMatch(/never “Publish anyway”/);
  });
});

describe('spotlightMayApprove', () => {
  const given = ['http://127.0.0.1:3399', 'Desk@Landflow.test'];
  it('takes a URL with and without its default port as one destination', () => {
    expect(normalDestination('http://example.test/path')).toBe('http://example.test:80');
    expect(spotlightMayApprove({ destinations: ['http://example.test:80/x'.replace('/x', '')] }, ['http://example.test'])).toBe(true);
    expect(spotlightMayApprove({ destinations: ['https://example.test'] }, ['https://example.test:443'])).toBe(true);
    expect(spotlightMayApprove({ destinations: ['http://127.0.0.1:3399/vip'] }, given)).toBe(true);
  });
  it('takes an e-mail address in another case as the same', () => {
    expect(spotlightMayApprove({ destinations: ['desk@landflow.test'] }, given)).toBe(true);
  });
  it('leaves a destination nobody gave, and approves a call that reaches none', () => {
    expect(spotlightMayApprove({ destinations: ['http://127.0.0.1:3400'] }, given)).toBe(false);
    expect(spotlightMayApprove({ destinations: ['http://127.0.0.1:3399', 'other@x.test'] }, given)).toBe(false);
    expect(spotlightMayApprove({ destinations: [] }, given)).toBe(true);
  });
});

describe('pickAlone', () => {
  const c = (id: string) => ({ id, name: `Cred ${id}` });
  it('picks only when exactly one fits', () => {
    expect(pickAlone([])).toBeUndefined();
    expect(pickAlone([c('a')])).toEqual(c('a'));
    expect(pickAlone([c('a'), c('b')])).toBeUndefined();
  });
});

describe('the lines', () => {
  it('says what it picked, kept, published and left unattended', () => {
    expect(pickedAloneLine('Sales DB', 'query_sales')).toBe('Picked “Sales DB” for “query_sales”: the only credential you have that fits.');
    expect(keptOwnFixLine({ summary: 'added “SQLite”' })).toContain('added “SQLite”');
    expect(publishedLine(4, [{ name: 'Analyst', version: 2 }])).toBe('Published: workflow v4 · Analyst v2. Production runs it from its next trigger.');
    expect(publishedLine(1, [])).toBe('Published: workflow v1. Production runs it from its next trigger.');
    expect(unattendedLine('send_email', 'webhook')).toContain('nobody approves “send_email”');
  });
  it('says who approved', () => {
    expect(approvedByLine({ kind: 'spotlight', userId: 'u', sessionId: 's' }, true)).toBe('Approved by Spotlight (autonomous fix session)');
    expect(approvedByLine({ kind: 'spotlight', userId: 'u', sessionId: 's' }, false)).toContain('Left for you by Spotlight');
    expect(approvedByLine({ kind: 'person', userId: 'u' }, true)).toBe('Approved by you');
    expect(approvedByLine({ kind: 'person', userId: 'u' }, false)).toBe('Denied by you');
  });
});
