/**
 * Who made a brain write (docs/features/notion-brain.md#how-it-is-built): the origin a change carries. Read from the request;
 * a name a caller supplies counts only when it is the request's own person.
 */
import type { BrainChangeOrigin } from '../../../shared/brain-store';
import { currentPrincipal } from '../../auth/guard';

/** Whether `userId` is the person the current request was authenticated as (a session, the test principal or an MCP call). */
export function isRequestPerson(userId: string | undefined): boolean {
  const principal = currentPrincipal();
  return Boolean(userId && principal && principal.user.id === userId && (principal.via === 'session' || principal.via === 'test' || principal.via === 'mcp'));
}

/**
 * An explicit `notion` (the puller, NB05) wins. An explicit `person` counts only when it names the person the request was
 * authenticated as (`isRequestPerson`): the memory façade passes it for a signed-in person's call or an API key over MCP
 * (C08 D7), and a flow run that claims it is still `landflow`. Otherwise `person` for a signed-in session or the test principal;
 * else `landflow`: a flow, the study, the loop.
 */
export function changeOrigin(explicit?: BrainChangeOrigin, by?: string): { origin: BrainChangeOrigin; by?: string } {
  if (explicit === 'notion') return { origin: 'notion', ...(by && { by }) };
  if (explicit === 'person' && isRequestPerson(by)) return { origin: 'person', by };
  const principal = currentPrincipal();
  if (principal?.via === 'session' || principal?.via === 'test') return { origin: 'person', by: principal.user.id };
  return { origin: 'landflow' };
}
