/**
 * AG06: an agent's node-tool dialog lists only the credentials the tool's settings use (the node panel's rule), and a
 * pick leaves only when the person's change to a parameter hid it. Made-up data, no DOM.
 */
import { describe, expect, it } from 'vitest';
import { isPropertyVisible, withPropertyDefaults } from '@landflow/protocol';
import { httpRequestNode } from '@/lib/server/nodes/data';
import { credentialsAfterChange, toolCredentialSlots } from '@/components/agents/capabilities-card';

const BEARER = { authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth' };
const descriptor = httpRequestNode.description;
const names = (parameters: Record<string, unknown>) => toolCredentialSlots(descriptor, parameters).map((c) => c.name);
// The node panel's own filter (node-panel.tsx).
const panel = (parameters: Record<string, unknown>) =>
  (descriptor.credentials ?? []).filter((c) => isPropertyVisible(c, withPropertyDefaults(descriptor.properties, parameters as never))).map((c) => c.name);

describe('node tool credentials', () => {
  it('lists no credential with Authentication None', () => {
    expect(names({ authentication: 'none' })).toEqual([]);
    expect(names({})).toEqual([]);
  });

  it('lists exactly the Bearer slot with Bearer chosen, and the node panel agrees', () => {
    const slots = toolCredentialSlots(descriptor, BEARER);
    expect(slots.map((c) => c.name)).toEqual(['httpBearerAuth']);
    expect(slots[0].required).toBe(true);
    for (const parameters of [{ authentication: 'none' }, BEARER, { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' }, {}]) {
      expect(names(parameters)).toEqual(panel(parameters));
    }
  });

  it('keeps a pick on open and drops it only when the change hides its slot', () => {
    const credentials = { httpBearerAuth: { id: 'cred_1' } } as never;
    // Reopening: no parameter change, nothing is dropped.
    expect(credentialsAfterChange(descriptor, BEARER, BEARER, credentials)).toBe(credentials);
    // An unrelated parameter change keeps it.
    expect(credentialsAfterChange(descriptor, BEARER, { ...BEARER, url: 'http://x' }, credentials)).toBe(credentials);
    // Changing the method hides the slot: the pick goes.
    expect(credentialsAfterChange(descriptor, BEARER, { authentication: 'none' }, credentials)).toEqual({});
    // A pick for a slot that was already hidden before the change stays (nothing the person changed).
    expect(credentialsAfterChange(descriptor, { authentication: 'none' }, { authentication: 'none', url: 'x' }, credentials)).toBe(credentials);
  });
});
