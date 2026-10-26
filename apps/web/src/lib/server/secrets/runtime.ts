/**
 * External secrets at run time. The plugin registry wraps every node type with `withExternalSecrets` (innermost,
 * after OAuth2 token renewal): before the call, credential fields that reference `$secrets` are resolved
 * (./resolve.ts); after it, the response is redacted (./redact.ts), so outputs and errors never carry a secret value
 * into executions, checkpoints, live events or logs. A secret that can't be read fails the node with the reason.
 *
 * Load options, app webhook registration and "Test connection" resolve through `resolveCredentialSecrets`.
 *
 * Node parameters that read `$secrets` (when Settings → External secrets allows it) are resolved by the engine with
 * `parameterSecretOptions`; each resolved value is remembered, so the redaction above covers it, and `redactRunData`
 * cleans the run's live events and result (an expression error the engine writes may quote a value).
 */
import type { ExecuteRequest, JsonObject } from '@landflow/protocol';
import type { ExecuteWorkflowOptions, ResolvedNodeType } from '@landflow/engine';
import type { ContextExtras } from '@landflow/sdk';
import { installRedaction } from './install';
import { hasSecretValues, redactValue, rememberSecretValues } from './redact';
import { loadParameterSecrets, resolveSecretsIn, resolveSecretsInRecord } from './resolve';

const withCredentials = async (request: ExecuteRequest): Promise<ExecuteRequest> => {
  installRedaction();
  const credentials = await resolveSecretsInRecord(request.credentials);
  return credentials ? { ...request, credentials } : request;
};

/** The node's live logs and streamed chunks go out redacted too (they become live events). */
function redactedExtras(extras: ContextExtras | undefined): ContextExtras | undefined {
  const { onLog, sendChunk } = extras ?? {};
  if (!extras || (!onLog && !sendChunk)) return extras;
  return {
    ...extras,
    ...(onLog && { onLog: (entry: Parameters<typeof onLog>[0]) => onLog(redactValue(entry)) }),
    ...(sendChunk && { sendChunk: (chunk: Parameters<typeof sendChunk>[0]) => sendChunk(redactValue(chunk)) }),
  };
}

export function withExternalSecrets(resolved: ResolvedNodeType): ResolvedNodeType {
  return {
    ...resolved,
    execute: async (request, extras) => {
      const prepared = await withCredentials(request);
      try {
        return redactValue(await resolved.execute(prepared, redactedExtras(extras)));
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

/** ExecuteWorkflowOptions for `$secrets` in node parameters: load them (or refuse), and redact what they resolved to. */
export const parameterSecretOptions: Pick<ExecuteWorkflowOptions, 'loadSecrets' | 'onSecretParameter'> = {
  loadSecrets: (references) => (installRedaction(), loadParameterSecrets(references)),
  onSecretParameter: (value) => rememberSecretValues(value, { lines: false }),
};

/** A run's live event or result without secret values; untouched while no secret was resolved in this process. */
export const redactRunData = <T>(value: T): T => (hasSecretValues() ? redactValue(value) : value);
