/**
 * Who made a brain write (docs/features/notion-brain.md#how-it-is-built): the origin a change carries. Read from the request,
 * never from a name a caller supplies.
 */
import type { BrainChangeOrigin } from '../../../shared/brain-store';
import { currentPrincipal } from '../../auth/guard';

/**
 * An explicit `notion` (the puller, NB05) wins; else `person` (with the user's id) for a signed-in session or the test
 * principal; else `landflow`: an API key, MCP, a flow, the study, the loop.
 */
export function changeOrigin(explicit?: BrainChangeOrigin, by?: string): { origin: BrainChangeOrigin; by?: string } {
  if (explicit === 'notion') return { origin: 'notion', ...(by && { by }) };
  const principal = currentPrincipal();
  if (principal?.via === 'session' || principal?.via === 'test') return { origin: 'person', by: principal.user.id };
  return { origin: 'landflow' };
}
