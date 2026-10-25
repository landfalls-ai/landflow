/**
 * Credentials (docs/protocol.md §7). A plugin declares credential types with
 * `definePlugin({ credentialTypes })`; the host stores the values and sends the
 * decrypted data keyed by local type name with every Execute / LoadOptions
 * call. Nodes read them with `ctx.getCredentials(name)`.
 */
import type { CredentialTypeDescriptor, JsonObject } from '@landflow/protocol';
import type { SpanFunction, TracedFetch } from './instrumentation';
import { NodeOperationError, type HttpRequestOptions, type HttpResponse, type ILogger } from './node';
import { secretValues } from './redact';

export interface CredentialTestResult {
  ok: boolean;
  /** Why the test failed (or a short success note, e.g. "Authenticated as @my_bot"). */
  message?: string;
}

export interface ICredentialTestContext {
  /** Local credential type name. */
  readonly credentialType: string;
  readonly logger: ILogger;
  /** Traced fetch, same as `ctx.http` in execute. */
  readonly http: TracedFetch;
  readonly span: SpanFunction;
  readonly helpers: { httpRequest(options: HttpRequestOptions): Promise<HttpResponse> };
}

/**
 * A credential type as authors write it: the wire descriptor plus an optional
 * `test` that makes it `testable` ("Test connection" in the UI). Make one cheap
 * authenticated call and return `{ ok: false, message }` on failure; a thrown
 * error is reported the same way.
 */
export interface CredentialTypeDefinition<T extends JsonObject = JsonObject> extends Omit<CredentialTypeDescriptor, 'testable'> {
  test?: (data: T, ctx: ICredentialTestContext) => Promise<CredentialTestResult> | CredentialTestResult;
}

/** Identity helper that types `data` in `test`. */
export function defineCredentialType<T extends JsonObject = JsonObject>(definition: CredentialTypeDefinition<T>): CredentialTypeDefinition<T> {
  return definition;
}

export interface GetCredentials {
  /** The node's only credential (undefined when none was sent). Throws when several were sent: pass a name. */
  <T extends JsonObject = JsonObject>(): T | undefined;
  /** The data of credential type `name`; throws a NodeOperationError when the host sent none. */
  <T extends JsonObject = JsonObject>(name: string): T;
  /** Same, but returns undefined instead of throwing (credentials declared `required: false`). */
  <T extends JsonObject = JsonObject>(name: string, options: { optional: true }): T | undefined;
}

/** "text-toolkit.telegramApi" → "telegramApi" (credential type names cannot contain dots). */
export const localCredentialName = (name: string) => name.slice(name.lastIndexOf('.') + 1);

export function credentialAccessor(credentials: Record<string, JsonObject> | undefined): GetCredentials {
  return ((name?: string, options?: { optional?: boolean }) => {
    const all = credentials ?? {};
    if (name === undefined) {
      const names = Object.keys(all);
      if (names.length === 0) return undefined;
      if (names.length === 1) return all[names[0]];
      throw new NodeOperationError(`This node received several credentials (${names.join(', ')})`, {
        description: 'Call ctx.getCredentials(name) with the credential type you need.',
      });
    }
    const data = all[localCredentialName(name)];
    if (data === undefined && !options?.optional) {
      throw new NodeOperationError(`No "${localCredentialName(name)}" credentials were provided`, {
        description: "Select a credential in the node's Credentials setting.",
      });
    }
    return data;
  }) as GetCredentials;
}

/** Secret values to redact for one request's credentials. */
export function requestSecrets(credentials: Record<string, JsonObject> | undefined, types: readonly CredentialTypeDefinition[] = []): string[] {
  if (!credentials) return [];
  return Object.entries(credentials).flatMap(([name, data]) => secretValues(data, types.find((t) => t.name === name)?.properties));
}
