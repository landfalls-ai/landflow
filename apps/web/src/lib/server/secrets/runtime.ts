/**
 * External secrets at run time. The plugin registry wraps every node type with `withExternalSecrets` (innermost,
 * after OAuth2 token renewal): before the call, credential fields that reference `$secrets` are resolved
 * (./resolve.ts); after it, the response is redacted (./redact.ts), so outputs and errors never carry a secret value
 * into executions, checkpoints, live events or logs. A secret that can't be read fails the node with the reason.
 *
 * Load options, app webhook registration and "Test connection" resolve through `resolveCredentialSecrets`.
 */
import type { ExecuteRequest, JsonObject } from '@landflow/protocol';
import type { ResolvedNodeType } from '@landflow/engine';
import { installRedaction } from './install';
import { redactValue } from './redact';
import { resolveSecretsIn, resolveSecretsInRecord } from './resolve';

const withCredentials = async (request: ExecuteRequest): Promise<ExecuteRequest> => {
  installRedaction();
  const credentials = await resolveSecretsInRecord(request.credentials);
  return credentials ? { ...request, credentials } : request;
};

export function withExternalSecrets(resolved: ResolvedNodeType): ResolvedNodeType {
  return {
    ...resolved,
    execute: async (request, extras) => {
      const prepared = await withCredentials(request);
      try {
        return redactValue(await resolved.execute(prepared, extras));
      } catch (error) {
        throw redactValue(error);
      }
    },
    ...(resolved.supplyData && {
      supplyData: async (request: ExecuteRequest, extras?: Parameters<NonNullable<ResolvedNodeType['supplyData']>>[1]) => resolved.supplyData!(await withCredentials(request), extras),
    }),
  };
}

/** Credentials by requirement name with `$secrets` resolved (the same record when none uses them). */
export async function resolveCredentialSecrets(record: Record<string, JsonObject> | undefined): Promise<Record<string, JsonObject> | undefined> {
  return (await resolveSecretsInRecord(record)) ?? record;
}

/** One credential's data with `$secrets` resolved (Test connection). */
export const resolveCredentialData = (data: JsonObject): Promise<JsonObject> => resolveSecretsIn(data);
