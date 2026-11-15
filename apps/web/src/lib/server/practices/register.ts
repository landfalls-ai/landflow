/**
 * Sets the practices port (./port) from the store: a side-effect import at the top of lib/server/runtime.ts, so the Draft
 * Practice node, the learn route, the applicable route and the MCP tools find the store without importing it.
 */
import { envString } from '../config';
import { getPractice, approvedPractices, draftPractice, recordApplication, versionsOf } from './store';
import { setPracticesPort, type PracticesPort } from './port';
import { viewOf } from './views';

/** `LANDFLOW_PRACTICES=off` stops practices reaching agents; drafting and approving still work. */
export const practicesEnabled = (): boolean => !/^(off|false|0)$/i.test(envString('LANDFLOW_PRACTICES') ?? '');

export const storePort: PracticesPort = {
  enabled: practicesEnabled,
  draft(input, origin) {
    const { practice, version } = draftPractice(input, origin);
    return { practice: viewOf(origin.actor, getPractice(practice.id) ?? practice, versionsOf(practice.id)), version };
  },
  approved: (scope) => (practicesEnabled() ? approvedPractices(scope) : []),
  record: recordApplication,
};

setPracticesPort(storePort);
