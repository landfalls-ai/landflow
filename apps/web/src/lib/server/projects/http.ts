/**
 * Shared pieces of the routes that deal with projects: the request's user, a handler that answers ProjectError with
 * its status, the `?projectId=` of list and create routes, and the share and transfer routes every shareable kind
 * uses (`/api/workflows/<id>/shares`, `/api/credentials/<id>/transfer`, …). The access checks themselves run in the
 * route guard (lib/server/auth/policy.ts `resourceRule`) before these handlers.
 */
import { z } from 'zod';
import { SHARE_ROLES, personalProjectId, type ResourceKind, type ShareableKind, type ShareView } from '../../shared/projects';
import { AuthError } from '../auth/errors';
import { currentPrincipal } from '../auth/guard';
import { getUser, type UserRecord } from '../auth/users';
import { error, handler, json, parseBody } from '../http';
import { creationProject, isInstanceAdmin, ownershipOf, projectRole } from './access';
import { ensurePersonalProject, forgetResource, getProject, ProjectError, replaceShares, setHomeProject, shares } from './store';
import { moveResource } from './transfer';

/** The signed-in user of the request (the guard ran: there is one). */
export function routeActor(): UserRecord {
  const principal = currentPrincipal();
  if (!principal) throw new AuthError('Sign in, or send an API key (Authorization: Bearer lf_…)', 401);
  return principal.user;
}

/** `handler` plus ProjectError → `{ error }` with its status. */
export function projectRoute<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return handler(async (...args: A) => {
    try {
      return await fn(...args);
    } catch (caught) {
      if (caught instanceof ProjectError) return error(caught.message, caught.status);
      throw caught;
    }
  });
}

/** `?projectId=` of a list or create request. */
export function projectParam(request: Request): string | null {
  try {
    return new URL(request.url).searchParams.get('projectId') || null;
  } catch {
    return null;
  }
}

/**
 * Create a resource in the requested project (`?projectId=`, else the caller's personal project): checks the caller
 * may create there, runs `create`, and records the new resource's home project.
 */
export function createInProject<T>(request: Request, kind: ResourceKind, create: () => T, idOf: (created: T) => string): T {
  const project = creationProject(currentPrincipal()?.user, projectParam(request));
  const created = create();
  if (project) setHomeProject(kind, idOf(created), project);
  return created;
}

/** A resource was deleted: forget its project and shares. */
export function forgetDeleted(kind: ResourceKind, id: string) {
  forgetResource(kind, id);
}

export function shareViews(kind: ShareableKind, id: string): ShareView[] {
  return shares(kind, id).flatMap((share) => {
    const project = getProject(share.projectId);
    if (!project) return [];
    return [{ projectId: project.id, projectName: project.name, projectType: project.type, ...(project.ownerId && { userId: project.ownerId }), role: share.role, createdAt: share.createdAt, ...(share.createdBy && { createdBy: share.createdBy }) }];
  });
}

const shareSchema = z.object({
  shares: z
    .array(z.union([z.object({ projectId: z.string().min(1), role: z.string() }), z.object({ userId: z.string().min(1), role: z.string() })]))
    .max(200),
});

/** GET/PUT `/api/<kind>/<id>/shares` (the guard checked read for GET, share for PUT). */
export function shareRoutes(kind: ShareableKind, exists: (id: string) => boolean) {
  type Ctx = { params: Promise<{ id: string }> };
  const notFound = kind === 'workflow' ? 'Workflow not found' : 'Credential not found';
  return {
    GET: projectRoute(async (_request: Request, { params }: Ctx) => {
      const { id } = await params;
      if (!exists(id)) return error(notFound, 404);
      return json({ ownership: ownershipOf(routeActor(), kind, id), shares: shareViews(kind, id) });
    }),
    /** PUT { shares: [{ projectId | userId, role }] } replaces the shares. */
    PUT: projectRoute(async (request: Request, { params }: Ctx) => {
      const { id } = await params;
      if (!exists(id)) return error(notFound, 404);
      const body = await parseBody(request, shareSchema);
      if (!body.ok) return body.response;
      const actor = routeActor();
      const home = ownershipOf(actor, kind, id).projectId;
      const wanted: Array<{ projectId: string; role: (typeof SHARE_ROLES)[ShareableKind][number] }> = [];
      for (const entry of body.data.shares) {
        if (!SHARE_ROLES[kind].includes(entry.role as never)) return error(`A ${kind} can be shared as ${SHARE_ROLES[kind].join(' or ')}, not “${entry.role}”`);
        let projectId: string;
        if ('userId' in entry) {
          const user = getUser(entry.userId);
          if (!user) return error('User not found', 404);
          projectId = ensurePersonalProject(user.id) ?? personalProjectId(user.id);
        } else {
          projectId = entry.projectId;
          if (!getProject(projectId)) return error('Project not found', 404);
        }
        if (projectId === home) continue;
        wanted.push({ projectId, role: entry.role as (typeof SHARE_ROLES)[ShareableKind][number] });
      }
      replaceShares(kind, id, wanted, actor.id);
      return json({ ownership: ownershipOf(actor, kind, id), shares: shareViews(kind, id) });
    }),
  };
}

const transferSchema = z.object({
  projectId: z.string().min(1),
  /** Credentials: stay usable by the project they leave (default true). */
  keepAccess: z.boolean().optional(),
  /** Workflows: share the credentials the workflow uses with the new project. */
  shareCredentials: z.boolean().optional(),
});

/**
 * POST `/api/<kind>/<id>/transfer` { projectId, keepAccess?, shareCredentials? }: "Move to project". The guard
 * checked the caller may move it (admin of its project); they must also be able to create in the target project.
 * `credentialsOf` lists the credential ids a workflow uses (for `shareCredentials`).
 */
export function transferRoute(kind: ResourceKind, exists: (id: string) => boolean, credentialsOf?: (id: string) => string[]) {
  type Ctx = { params: Promise<{ id: string }> };
  return projectRoute(async (request: Request, { params }: Ctx) => {
    const { id } = await params;
    if (!exists(id)) return error('Not found', 404);
    const body = await parseBody(request, transferSchema);
    if (!body.ok) return body.response;
    const actor = routeActor();
    const target = getProject(body.data.projectId);
    if (!target) return error('Project not found', 404);
    const role = projectRole(actor, target.id);
    if (role !== 'admin' && role !== 'editor') return error(`You can’t move things into “${target.name}”`, 403);
    // Only credentials the mover may share go along (owners and admins: all of them).
    const shareable = body.data.shareCredentials && credentialsOf ? credentialsOf(id).filter((credentialId) => isInstanceAdmin(actor) || projectRole(actor, ownershipOf(actor, 'credential', credentialId).projectId) === 'admin') : [];
    const { from } = moveResource(kind, id, target.id, { keepAccess: body.data.keepAccess, shareCredentials: shareable, actorId: actor.id });
    return json({ ownership: ownershipOf(actor, kind, id), from, sharedCredentials: shareable });
  });
}
