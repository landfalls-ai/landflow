/**
 * Fresh OAuth2 tokens for every node call. The registry wraps each node type it resolves with `withFreshTokens`:
 * before the call, an OAuth2 credential in `request.credentials` whose token expires within a minute is renewed
 * (and saved); when the node then fails with what looks like a 401, the token is renewed once more and the node
 * runs again, once. Plugins see none of this: they get a valid `accessToken` in ExecuteRequest.credentials.
 *
 * The retry re-runs the whole node call, so a node that made other requests before the one that was refused makes
 * them again; in practice the first request is the one an expired token fails.
 */
import type { ExecuteRequest, ExecuteResponse, JsonObject } from '@landflow/protocol';
import type { ResolvedNodeType } from '@landflow/engine';
import { credentials } from './vault';
import { looksUnauthorized } from './oauth2';

const withCredentials = (request: ExecuteRequest, record: Record<string, JsonObject> | undefined): ExecuteRequest => (record ? { ...request, credentials: record } : request);

/** Whether any of the request's credentials is an OAuth2 credential the host can renew. */
const hasOAuth2 = (request: ExecuteRequest) => Object.values(request.credentials ?? {}).some((data) => credentials.oauth2Origin(data));

/** A failed call whose error reads like the API refused the token. */
function unauthorized(response: ExecuteResponse | undefined, thrown?: unknown): boolean {
  if (thrown) return looksUnauthorized((thrown as Error)?.message);
  return Boolean(response?.error && looksUnauthorized(`${response.error.message} ${response.error.description ?? ''}`));
}

export function withFreshTokens(resolved: ResolvedNodeType): ResolvedNodeType {
  const call = async (run: (request: ExecuteRequest) => Promise<ExecuteResponse>, request: ExecuteRequest): Promise<ExecuteResponse> => {
    if (!hasOAuth2(request)) return run(request);
    const prepared = withCredentials(request, await credentials.freshen(request.credentials));
    let response: ExecuteResponse | undefined;
    let thrown: unknown;
    try {
      response = await run(prepared);
    } catch (error) {
      thrown = error;
    }
    if (unauthorized(response, thrown)) {
      const renewed = await credentials.freshen(prepared.credentials, true);
      if (renewed) return run(withCredentials(prepared, renewed));
    }
    if (thrown) throw thrown;
    return response!;
  };
  return {
    ...resolved,
    execute: (request, extras) => call((next) => resolved.execute(next, extras), request),
    ...(resolved.supplyData && {
      // Sub-nodes (an agent's tools) get a renewed token too; their calls happen later, inside the agent.
      supplyData: async (request: ExecuteRequest, extras?: Parameters<NonNullable<ResolvedNodeType['supplyData']>>[1]) =>
        resolved.supplyData!(withCredentials(request, await credentials.freshen(request.credentials)), extras),
    }),
  };
}

/** LoadOptions calls: the credentials with renewed tokens (no retry: a dropdown can be reloaded). */
export async function freshCredentials(record: Record<string, JsonObject> | undefined): Promise<Record<string, JsonObject> | undefined> {
  return (await credentials.freshen(record)) ?? record;
}
