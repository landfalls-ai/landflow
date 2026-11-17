/**
 * Wave ag3 fix pass (AG15 review, non-blocking): the cases an asks-first tool rewrites. A tool word ("send") names the tool only as
 * a whole word with its plain endings, never inside a longer one ("sender"); and a leading noun ("Email from the on-call lead is
 * read", "Email has the alert's host") is not the verb that claims the send.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-gate-words-ag3-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
const { asksFirstCases } = await import('@/lib/server/assistant/architect');

const tool = (name: string) => ({ tools: [{ id: 't', type: 'node', name, description: 'x', nodeType: 'messaging.emailSend', parameters: {}, requireApproval: true }] }) as never;
const rewrite = (expected: string, name = 'Send Email') => asksFirstCases([{ input: 'i', expected }], tool(name))[0]!.expected;

describe('a tool word is a whole word', () => {
  it('"send" does not match "sender"', () => {
    // "Creates ..." is a claim, but it names the Send tool only through "sender": left as it is.
    const same = 'Creates a record from the sender address.';
    expect(rewrite(same, 'Send')).toBe(same);
  });

  it('its plain endings still do: sends, emailed, emails', () => {
    expect(rewrite('Sends a summary to oncall@landflow.test.')).toMatch(/asks for approval/);
    expect(rewrite('Emails a summary to oncall@landflow.test.')).toMatch(/asks for approval/);
    expect(rewrite('The alert was emailed to oncall@landflow.test.')).toMatch(/asks for approval/);
  });
});

describe('a leading noun is not the verb', () => {
  it('"Email from / is / was / has …" at the start claims nothing', () => {
    for (const same of ['Email from the on-call lead is read first.', 'Email is the channel it uses for hand-over.', 'Email has the alert host in its subject.']) expect(rewrite(same), same).toBe(same);
  });

  it('the verb at the start still does', () => {
    expect(rewrite('Email oncall@landflow.test a short summary.')).toMatch(/asks for approval/);
  });
});
