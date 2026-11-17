/**
 * Wave ag3 carryover (the live pass, Grafana agent): "also let it acknowledge an alert" added Acknowledge Alert and its step,
 * yet the base's Hand over line still said to hand over when "the user asks to acknowledge, silence or fix an alert", so the
 * published agent answered "I can't acknowledge alerts". The added tool's verb, when the change says it, leaves that line.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-handover-ag3-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
const { withoutHandOverFor } = await import('@/lib/server/assistant/architect');

const ack = [{ id: 't', type: 'node', name: 'acknowledge_alert', description: 'x', nodeType: 'grafana.acknowledgeAlert', parameters: {}, requireApproval: true }] as never;
const LIVE = 'Steps:\n5. When it should acknowledge an alert, call acknowledge_alert (it asks the person first).\nOutput: a short answer.\nHand over when: The user asks to acknowledge, silence or fix an alert, or gives no dashboard URL and the dashboard cannot be found. Say a person must do it.';

describe('a tool the change adds leaves the Hand over line', () => {
  it("the live pass's line: acknowledge leaves the list, the rest stays word for word", () => {
    const out = withoutHandOverFor(LIVE, ack, 'also let it acknowledge an alert');
    expect(out.split('\n').at(-1)).toBe('Hand over when: The user asks to silence or fix an alert, or gives no dashboard URL and the dashboard cannot be found. Say a person must do it.');
    expect(out).toContain('5. When it should acknowledge an alert, call acknowledge_alert');
  });

  it('at the end of a list, or alone in its clause', () => {
    expect(withoutHandOverFor('Hand over when: asked to silence or acknowledge an alert.', ack, 'let it acknowledge alerts')).toBe('Hand over when: Asked to silence an alert.');
    expect(withoutHandOverFor('Hand over when: the user asks to acknowledge an alert; the data is missing.', ack, 'let it acknowledge alerts')).toBe('Hand over when: The data is missing.');
    expect(withoutHandOverFor('Hand over when: the user asks to acknowledge an alert.', ack, 'let it acknowledge alerts')).toBe('Hand over when: It cannot do what was asked.');
  });

  it('a change that does not say the verb leaves the line whole', () => {
    expect(withoutHandOverFor(LIVE, ack, 'add the Grafana tool')).toBe(LIVE);
  });
});
