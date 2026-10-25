import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FolderError, FolderNotEmptyError, FolderStore } from '@/lib/server/folders';

const dir = mkdtempSync(join(tmpdir(), 'landflow-folders-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let counter = 0;
const fresh = () => new FolderStore(join(dir, `folders-${++counter}.json`));

describe('FolderStore', () => {
  it('creates nested folders and walks the path from the top', () => {
    const folders = fresh();
    const clients = folders.create({ name: '  Clients ' });
    const acme = folders.create({ name: 'Acme', parentId: clients.id });
    const billing = folders.create({ name: 'Billing', parentId: acme.id });
    expect(clients.name).toBe('Clients');
    expect(clients.id).toMatch(/^fd_/);
    expect(clients.parentId).toBeUndefined();
    expect(folders.path(billing.id).map((f) => f.name)).toEqual(['Clients', 'Acme', 'Billing']);
    expect(folders.path('fd_missing')).toEqual([]);
    expect(folders.list().map((f) => f.name)).toEqual(['Acme', 'Billing', 'Clients']);
  });

  it('validates names and parents', () => {
    const folders = fresh();
    expect(() => folders.create({ name: '   ' })).toThrow(FolderError);
    expect(() => folders.create({ name: 'x'.repeat(121) })).toThrow(/at most 120/);
    expect(() => folders.create({ name: 'Orphan', parentId: 'fd_nope' })).toThrow(/Parent folder not found/);
  });

  it('renames and moves, rejecting cycles', () => {
    const folders = fresh();
    const a = folders.create({ name: 'A' });
    const b = folders.create({ name: 'B', parentId: a.id });
    const c = folders.create({ name: 'C', parentId: b.id });
    expect(folders.update(a.id, { name: 'Alpha' }).name).toBe('Alpha');
    expect(() => folders.update(a.id, { parentId: a.id })).toThrow(/into itself/);
    expect(() => folders.update(a.id, { parentId: c.id })).toThrow(/subfolders/);
    expect(folders.update(c.id, { parentId: a.id }).parentId).toBe(a.id);
    expect(folders.update(c.id, { parentId: null }).parentId).toBeUndefined();
    expect(() => folders.update('fd_nope', { name: 'x' })).toThrow(expect.objectContaining({ status: 404 }));
  });

  it('deletes a folder only when it holds no folders and no workflows', () => {
    const folders = fresh();
    const parent = folders.create({ name: 'Parent' });
    const child = folders.create({ name: 'Child', parentId: parent.id });
    expect(() => folders.delete(parent.id, [])).toThrow(FolderNotEmptyError);
    expect(() => folders.delete(child.id, [{ folderId: child.id }, { folderId: undefined }])).toThrow(/1 workflow/);
    try {
      folders.delete(parent.id, [{ folderId: parent.id }]);
    } catch (error) {
      expect(error).toMatchObject({ folders: 1, workflows: 1 });
    }
    expect(folders.delete(child.id, [{ folderId: parent.id }])).toBe(true);
    expect(folders.delete(parent.id, [])).toBe(true);
    expect(folders.delete(parent.id, [])).toBe(false);
    expect(folders.list()).toEqual([]);
  });

  it('persists to its file', () => {
    const file = join(dir, 'persisted.json');
    const first = new FolderStore(file);
    const top = first.create({ name: 'Top' });
    first.create({ name: 'Inner', parentId: top.id });
    first.update(top.id, { name: 'Top level' });
    const second = new FolderStore(file);
    expect(second.list().map((f) => [f.name, f.parentId ?? null])).toEqual([
      ['Inner', top.id],
      ['Top level', null],
    ]);
  });
});
