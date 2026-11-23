/**
 * Wave ag3 carryover (the live pass, triage agent held at 2.8 / 5): two of the design's four cases still expected the send
 * ("Normalises it, no IOCs, sev1 with reason, emails oncall@landflow.test.", "Low severity (sev3/sev4), no IOCs, short email
 * sent.") because "no IOCs" read as a negation of the whole case. A negation now counts only in its own clause: the send's
 * clause is rewritten to the ask (the address kept), the other clauses stay word for word, and a negated send stays as it is.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-gate-cases-ag3-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
const { asksFirstCases } = await import('@/lib/server/assistant/architect');

const config = { tools: [{ id: 't', type: 'node', name: 'send_email', description: 'x', nodeType: 'messaging.emailSend', parameters: {}, requireApproval: true }] } as never;

describe('a compound case: the negation is judged per clause', () => {
  it('rewrites the send clause of the live pass\'s two cases and keeps the rest exactly', () => {
    const [a, b] = asksFirstCases(
      [
        { input: 'a', expected: 'Normalises it, no IOCs, sev1 with reason, emails oncall@landflow.test.' },
        { input: 'b', expected: 'Low severity (sev3/sev4), no IOCs, short email sent.' },
      ],
      config,
    );
    expect(a!.expected).toBe('Normalises it, no IOCs, sev1 with reason, drafts the email for oncall@landflow.test and asks for approval before sending it.');
    expect(b!.expected).toBe('Low severity (sev3/sev4), no IOCs, drafts short email and asks for approval before sending it (not sent).');
    expect(a!.input).toBe('a');
  });

  it('a negated send, alone or in a compound case, stays as it is', () => {
    const same = [
      { input: 'a', expected: 'Says the alert is noise and sends no email.' },
      { input: 'b', expected: 'Does not send an email; says it is benign.' },
      { input: 'c', expected: 'No IOCs, sev4, sends no email.' },
      { input: 'd', expected: 'No IOCs, lists nothing, says it is benign.' },
    ];
    expect(asksFirstCases(same, config)).toEqual(same);
  });
});
