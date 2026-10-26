/**
 * Folders for the workflows list, kept in the `folders` table (lib/server/db), or in a JSON file
 * when a FolderStore is given one (the format older versions used; tests use it too). Folders nest
 * through `parentId`; a workflow sits in one through `workflow.folderId`. A folder can only be
 * deleted when it holds no folders and no workflows.
 *
 * Every folder belongs to one project (`projectId`, migration 1400; none = the default project, the instance
 * owner's personal one), and so do its subfolders: a subfolder is made in its parent's project and a folder only
 * moves under a parent of its own project. A workflow is only filed in a folder of its own project; one whose
 * folder belongs to another project (left over from before projects had folders) shows at the top level there.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { nanoid } from 'nanoid';
import type { Folder } from '../shared/types';
import { folderRow } from './db/rows';
import { projectsDb } from './projects/db';
import { defaultProjectId } from './projects/store';
import { singleton } from './singleton';

const MAX_NAME = 120;

/** Thrown by FolderStore.delete when the folder still holds folders or workflows. */
export class FolderNotEmptyError extends Error {
  constructor(
    readonly folders: number,
    readonly workflows: number,
  ) {
    const parts = [folders && `${folders} folder${folders === 1 ? '' : 's'}`, workflows && `${workflows} workflow${workflows === 1 ? '' : 's'}`].filter(Boolean);
    super(`The folder isn't empty: it holds ${parts.join(' and ')}`);
    this.name = 'FolderNotEmptyError';
  }
}

/** A bad name, a missing parent or a move that would make a cycle. */
export class FolderError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'FolderError';
  }
}

function cleanName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new FolderError('A folder needs a name');
  if (trimmed.length > MAX_NAME) throw new FolderError(`Folder names are at most ${MAX_NAME} characters`);
  return trimmed;
}

export class FolderStore {
  private cached?: Folder[];

  /** `file`: keep the folders in that JSON file instead of the database. */
  constructor(private readonly file?: string) {}

  /** Loaded on first use (Postgres mode loads the database during bootstrap). */
  private get folders(): Folder[] {
    this.cached ??= this.load();
    return this.cached;
  }

  private set folders(list: Folder[]) {
    this.cached = list;
  }

  private load(): Folder[] {
    if (!this.file) {
      return projectsDb()
        .all<{ id: string; name: string; parent_id: string | null; project_id: string | null; created_at: string; updated_at: string }>('SELECT id, name, parent_id, project_id, created_at, updated_at FROM folders')
        .map((row) => ({ id: row.id, name: row.name, ...(row.parent_id && { parentId: row.parent_id }), ...(row.project_id && { projectId: row.project_id }), createdAt: row.created_at, updatedAt: row.updated_at }));
    }
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as { folders?: Folder[] };
      return Array.isArray(data.folders) ? data.folders : [];
    } catch {
      return [];
    }
  }

  /** Save a created or changed folder, or remove a deleted one. */
  private persist(change: { saved: Folder } | { removed: string }) {
    if (!this.file) {
      if ('saved' in change) projectsDb().upsert('folders', folderRow(change.saved));
      else projectsDb().delete('folders', { id: change.removed });
      return;
    }
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    writeFileSync(tmp, JSON.stringify({ folders: this.folders }, null, 2));
    renameSync(tmp, this.file);
  }

  /** Every folder, sorted by name. */
  list(): Folder[] {
    return [...this.folders].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): Folder | undefined {
    return this.folders.find((f) => f.id === id);
  }

  /** The folders from the top level down to `id` (for a breadcrumb); empty for an unknown id. */
  path(id: string): Folder[] {
    const chain: Folder[] = [];
    const seen = new Set<string>();
    for (let folder = this.get(id); folder && !seen.has(folder.id); folder = folder.parentId ? this.get(folder.parentId) : undefined) {
      seen.add(folder.id);
      chain.unshift(folder);
    }
    return chain;
  }

  /** The project a folder belongs to (its own, else the default project). */
  projectOf(folder: Folder | string | undefined, fallback?: string): string | undefined {
    const found = typeof folder === 'string' ? this.get(folder) : folder;
    if (!found) return undefined;
    return found.projectId ?? fallback ?? defaultProjectId();
  }

  /** The folders of `projectId` (or of any of a set of projects), sorted by name. */
  listIn(projectId: string | undefined | Set<string>): Folder[] {
    const fallback = defaultProjectId();
    const wanted = (id: string | undefined) => (projectId instanceof Set ? Boolean(id) && projectId.has(id!) : id === projectId);
    return this.list().filter((f) => wanted(f.projectId ?? fallback));
  }

  /**
   * `id`: keep a given id (Git sync creates folders under the ids in its files). `projectId`: the project of a new
   * top-level folder (default: the default project); a subfolder always goes to its parent's project.
   */
  create(input: { name: string; parentId?: string; id?: string; projectId?: string }): Folder {
    const name = cleanName(input.name);
    const parent = input.parentId ? this.get(input.parentId) : undefined;
    if (input.parentId && !parent) throw new FolderError('Parent folder not found', 404);
    if (input.id !== undefined && (!/^[\w-]+$/.test(input.id) || this.get(input.id))) throw new FolderError(`Folder id "${input.id}" is invalid or taken`, 409);
    const projectId = parent ? this.projectOf(parent) : (input.projectId ?? defaultProjectId());
    if (parent && input.projectId && input.projectId !== projectId) throw new FolderError('A subfolder belongs to its parent’s project');
    const now = new Date().toISOString();
    const folder: Folder = { id: input.id ?? `fd_${nanoid(8)}`, name, ...(input.parentId && { parentId: input.parentId }), ...(projectId && { projectId }), createdAt: now, updatedAt: now };
    this.folders = [...this.folders, folder];
    this.persist({ saved: folder });
    return folder;
  }

  /** Rename and/or move a folder. `parentId: null` moves it to the top level. */
  update(id: string, patch: { name?: string; parentId?: string | null }): Folder {
    const folder = this.get(id);
    if (!folder) throw new FolderError('Folder not found', 404);
    const next: Folder = { ...folder };
    if (patch.name !== undefined) next.name = cleanName(patch.name);
    if (patch.parentId === null) delete next.parentId;
    else if (patch.parentId !== undefined) {
      if (!this.get(patch.parentId)) throw new FolderError('Parent folder not found', 404);
      if (this.path(patch.parentId).some((f) => f.id === id)) throw new FolderError('A folder can’t move into itself or one of its subfolders');
      if (this.projectOf(patch.parentId) !== this.projectOf(folder)) throw new FolderError('A folder can only move into a folder of its own project');
      next.parentId = patch.parentId;
    }
    next.updatedAt = new Date().toISOString();
    this.folders = this.folders.map((f) => (f.id === id ? next : f));
    this.persist({ saved: next });
    return next;
  }

  /** Delete an empty folder. Returns false for an unknown id; throws FolderNotEmptyError when it holds anything. */
  delete(id: string, workflows: Array<{ folderId?: string }>): boolean {
    if (!this.get(id)) return false;
    const children = this.folders.filter((f) => f.parentId === id).length;
    const inside = workflows.filter((w) => w.folderId === id).length;
    if (children || inside) throw new FolderNotEmptyError(children, inside);
    this.folders = this.folders.filter((f) => f.id !== id);
    this.persist({ removed: id });
    return true;
  }

  /**
   * Hand every folder of `fromProjectId` to `toProjectId` (deleting a team project or removing a user with a
   * transfer: their workflows keep their folders). Returns how many moved.
   */
  reassignProject(fromProjectId: string, toProjectId: string): number {
    const fallback = defaultProjectId();
    const moving = this.folders.filter((f) => (f.projectId ?? fallback) === fromProjectId);
    if (!moving.length) return 0;
    const now = new Date().toISOString();
    const ids = new Set(moving.map((f) => f.id));
    this.folders = this.folders.map((f) => (ids.has(f.id) ? { ...f, projectId: toProjectId, updatedAt: now } : f));
    for (const folder of this.folders) if (ids.has(folder.id)) this.persist({ saved: folder });
    return moving.length;
  }

  /** Remove every folder of `projectId` (a deleted project that owned nothing else). */
  removeProject(projectId: string): number {
    const fallback = defaultProjectId();
    const removing = this.folders.filter((f) => (f.projectId ?? fallback) === projectId);
    this.folders = this.folders.filter((f) => !removing.includes(f));
    for (const folder of removing) this.persist({ removed: folder.id });
    return removing.length;
  }
}

export const folders = singleton('folders', () => new FolderStore());
/** Queue mode: another process changed folders (they are read again on next use). */
export function reloadFolders() {
  (folders as unknown as { cached?: Folder[] }).cached = undefined;
}
// Hot reload keeps the first instance (see singleton.ts): give it the current class's methods.
Object.setPrototypeOf(folders, FolderStore.prototype);
