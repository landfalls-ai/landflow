/**
 * Who made a brain write (docs/features/notion-brain.md#how-it-is-built): the origin a change carries. Read from the request,
 * never from a name a caller supplies.
 */
import type { BrainChangeOrigin } from '../../../shared/brain-store';
import { currentPrincipal } from '../../auth/guard';

/**
 * An explicit `notion` (the puller, NB05) wins; an explicit `person` with the user's id (server code that authenticated that
 * person: the memory façade for a session or an API key over MCP, C08 D7) is theirs; else `person` for a signed-in session or the
 * test principal; else `landflow`: a flow, the study, the loop.
 */
export function changeOrigin(explicit?: BrainChangeOrigin, by?: string): { origin: BrainChangeOrigin; by?: string } {
  if (explicit === 'notion') return { origin: 'notion', ...(by && { by }) };
  // A caller that names the person it acts for (an API key over MCP, C08 D7) is that person's write whatever the request context holds.
  if (explicit === 'person' && by) return { origin: 'person', by };
  const principal = currentPrincipal();
  if (principal?.via === 'session' || principal?.via === 'test') return { origin: 'person', by: principal.user.id };
  return { origin: 'landflow' };
}
