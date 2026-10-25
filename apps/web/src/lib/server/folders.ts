/**
 * Folders for the workflows list, kept in `<dataDir>/folders.json`. Folders
 * nest through `parentId`; a workflow sits in one through `workflow.folderId`.
 * A folder can only be deleted when it holds no folders and no workflows.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nanoid } from 'nanoid';
import type { Folder } from '../shared/types';
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
  private folders: Folder[];

  constructor(private readonly file = join(process.env.LANDFLOW_DATA_DIR ?? join(process.cwd(), '.data'), 'folders.json')) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as { folders?: Folder[] };
      this.folders = Array.isArray(data.folders) ? data.folders : [];
    } catch {
      this.folders = [];
    }
  }

  private persist() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
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

  create(input: { name: string; parentId?: string }): Folder {
    const name = cleanName(input.name);
    if (input.parentId && !this.get(input.parentId)) throw new FolderError('Parent folder not found', 404);
    const now = new Date().toISOString();
    const folder: Folder = { id: `fd_${nanoid(8)}`, name, ...(input.parentId && { parentId: input.parentId }), createdAt: now, updatedAt: now };
    this.folders.push(folder);
    this.persist();
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
      next.parentId = patch.parentId;
    }
    next.updatedAt = new Date().toISOString();
    this.folders = this.folders.map((f) => (f.id === id ? next : f));
    this.persist();
    return next;
  }

  /** Delete an empty folder. Returns false for an unknown id; throws FolderNotEmptyError when it holds anything. */
  delete(id: string, workflows: Array<{ folderId?: string }>): boolean {
    if (!this.get(id)) return false;
    const children = this.folders.filter((f) => f.parentId === id).length;
    const inside = workflows.filter((w) => w.folderId === id).length;
    if (children || inside) throw new FolderNotEmptyError(children, inside);
    this.folders = this.folders.filter((f) => f.id !== id);
    this.persist();
    return true;
  }
}

export const folders = singleton('folders', () => new FolderStore());
// Hot reload keeps the first instance (see singleton.ts): give it the current class's methods.
Object.setPrototypeOf(folders, FolderStore.prototype);
