/**
 * Folders per project (../folders.ts keeps them): the folder routes' access checks and the rule that a workflow is
 * only filed in a folder of its own project. Folder access follows project roles: members of the folder's project see
 * it, its editors and admins change it (owners and admins of the instance: every folder).
 */
import { projectRoleCan } from '../../shared/projects';
import type { Folder } from '../../shared/types';
import { AuthError } from '../auth/errors';
import { folders } from '../folders';
import { projectRole, type Actor } from './access';
import { defaultProjectId, getProject, homeProjectId } from './store';

/** Folders with their project filled in (a folder without one belongs to the default project). */
export function folderViews(list: Folder[]): Folder[] {
  const fallback = defaultProjectId();
  return list.map((folder) => (folder.projectId || !fallback ? folder : { ...folder, projectId: fallback }));
}

/** The folder `id` if `actor` may see it (`edit`: and change it); throws AuthError (404/403) otherwise. */
export function requireFolder(actor: Actor | undefined, id: string, action: 'read' | 'edit'): Folder & { projectId?: string } {
  const folder = folders.get(id);
  const projectId = folder && folders.projectOf(folder);
  const role = projectRole(actor, projectId);
  if (!folder || !role) throw new AuthError('Folder not found', 404);
  if (action === 'edit' && !projectRoleCan.create(role)) throw new AuthError(`Only editors of “${getProject(projectId ?? '')?.name ?? 'its project'}” can change this folder`, 403);
  return { ...folder, ...(projectId && { projectId }) };
}

/**
 * Why a workflow of `workflowProjectId` can't go in folder `folderId` (missing, or of another project), or undefined
 * when it can.
 */
export function folderProblem(folderId: string, workflowProjectId: string | undefined): { status: 400 | 404; message: string } | undefined {
  const folder = folders.get(folderId);
  if (!folder) return { status: 404, message: 'Folder not found' };
  const projectId = folders.projectOf(folder);
  if (projectId !== workflowProjectId) {
    return { status: 400, message: `“${folder.name}” is a folder of ${getProject(projectId ?? '')?.name ? `“${getProject(projectId!)!.name}”` : 'another project'}: a workflow only goes in a folder of its own project (move it to that project first)` };
  }
  return undefined;
}

/** The folder of a workflow as its project sees it: its folder when that is one of its project's, else none (the top level). */
export function workflowFolderIn(workflow: { id: string; folderId?: string }, projectId = homeProjectId('workflow', workflow.id)): string | undefined {
  if (!workflow.folderId) return undefined;
  return folders.projectOf(workflow.folderId) === projectId ? workflow.folderId : undefined;
}
