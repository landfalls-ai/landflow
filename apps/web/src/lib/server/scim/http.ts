/**
 * SCIM 2.0 over HTTP (RFC 7644): `application/scim+json` responses, errors in the SCIM error schema with a
 * `scimType`, and `scimRoute`, the wrapper every /scim/v2 route uses. The path is public to the proxy and the API
 * guard (lib/shared/auth-paths.ts); `scimRoute` authenticates the bearer token itself (./auth) and runs the handler
 * as the token's user, so "who changed this" works as it does for API keys.
 */
import { noteAuditPrincipal } from '../audit/context';
import { withAuth, type Principal } from '../auth/context';
import { clientIp } from '../auth/rate-limit';
import { publicOrigin } from '../auth/cookies';
import { UserError } from '../auth/users';
import { HttpError } from '../errors';
import { handler } from '../http';
import { ProjectError } from '../projects/store';
import { authenticateScim, type ScimCaller } from './auth';
import { recordScimAuthFailure } from './audit';

export const SCIM_CONTENT_TYPE = 'application/scim+json';

export const SCHEMAS = {
  user: 'urn:ietf:params:scim:schemas:core:2.0:User',
  group: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  enterpriseUser: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
  list: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  patch: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
  error: 'urn:ietf:params:scim:api:messages:2.0:Error',
  serviceProviderConfig: 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig',
  resourceType: 'urn:ietf:params:scim:schemas:core:2.0:ResourceType',
  schema: 'urn:ietf:params:scim:schemas:core:2.0:Schema',
} as const;

/** RFC 7644 §3.12 error types. */
export type ScimType = 'invalidFilter' | 'tooMany' | 'uniqueness' | 'mutability' | 'invalidSyntax' | 'invalidPath' | 'noTarget' | 'invalidValue' | 'invalidVers' | 'sensitive';

export class ScimError extends HttpError {
  constructor(
    status: number,
    message: string,
    readonly scimType?: ScimType,
  ) {
    super(message, status, { code: scimType ?? 'scim_error' });
  }
}

export function scimJson(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': SCIM_CONTENT_TYPE, ...headers } });
}

export function scimError(status: number, detail: string, scimType?: ScimType, headers: Record<string, string> = {}): Response {
  return scimJson({ schemas: [SCHEMAS.error], status: String(status), ...(scimType && { scimType }), detail }, status, headers);
}

/**
 * A normalized route error as a SCIM error document. The generic 500 carries its request id in `detail` too (the
 * error schema has no field for it; the `X-Request-Id` header has it as well), so a support request can quote it.
 */
export function scimErrorFor(http: HttpError): Response {
  const requestId = typeof http.details?.requestId === 'string' ? http.details.requestId : undefined;
  const detail = requestId && http.status >= 500 ? `${http.message} (request ${requestId})` : http.message;
  return scimError(http.status, detail, http instanceof ScimError ? http.scimType : undefined);
}

/** 204 No Content (DELETE). */
export const noContent = () => new Response(null, { status: 204 });

/** The SCIM base URL resources' `meta.location` and Settings → Security show: `<public URL>/scim/v2`. */
export function scimBaseUrl(request?: Request): string {
  return `${publicOrigin(request)}/scim/v2`;
}

/** The request body as JSON (SCIM clients send application/scim+json, some application/json). */
export async function scimBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ScimError(400, 'The request body must be JSON', 'invalidSyntax');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ScimError(400, 'The request body must be a JSON object', 'invalidSyntax');
  return body as Record<string, unknown>;
}

export interface ScimContext {
  request: Request;
  caller: ScimCaller;
  /** `<public URL>/scim/v2`. */
  base: string;
}

/**
 * Wrap a /scim/v2 route: `handler` (lib/server/http.ts: audit context and request id, readiness wait, drain, generic
 * 500) with the SCIM token check in place of the session guard, and every error rendered as a SCIM error document.
 * ScimError, and the user and project errors the stores throw, come back with their status and `scimType`.
 */
export function scimRoute<P extends Record<string, string> = Record<string, string>>(fn: (ctx: ScimContext, params: P) => Promise<Response>) {
  return handler(
    async (request: Request, context?: { params?: Promise<P> }): Promise<Response> => {
      const params = ((await context?.params) ?? {}) as P;
      const checked = authenticateScim(request);
      if (!checked.ok) {
        recordScimAuthFailure(clientIp(request), checked.status, checked.message, checked.keyId && checked.userId ? { keyId: checked.keyId, userId: checked.userId } : undefined);
        return scimError(checked.status, checked.message, undefined, checked.status === 401 ? { 'www-authenticate': 'Bearer realm="landflow-scim"' } : {});
      }
      const { caller } = checked;
      const principal: Principal = { user: caller.user, via: 'api-key', apiKey: { id: caller.keyId, scopes: caller.scopes } };
      noteAuditPrincipal(principal);
      return withAuth({ principal }, () => fn({ request, caller, base: scimBaseUrl(request) }, params));
    },
    {
      mapError: (caught) => {
        if (caught instanceof UserError || caught instanceof ProjectError) {
          return new ScimError(caught.status, caught.message, caught.status === 409 ? 'uniqueness' : caught.status === 400 ? 'invalidValue' : undefined);
        }
        return undefined;
      },
      formatError: scimErrorFor,
    },
  );
}

/** A discovery route (ServiceProviderConfig, Schemas, ResourceTypes): static documents, answered without a token. */
export function scimPublicRoute<P extends Record<string, string> = Record<string, string>>(fn: (base: string, params: P) => Response) {
  return async (request: Request, context?: { params?: Promise<P> }): Promise<Response> => {
    try {
      return fn(scimBaseUrl(request), ((await context?.params) ?? {}) as P);
    } catch (caught) {
      if (caught instanceof ScimError) return scimError(caught.status, caught.message, caught.scimType);
      throw caught;
    }
  };
}
