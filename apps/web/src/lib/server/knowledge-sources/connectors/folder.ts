/**
 * C22: the folder connector: a folder of the host's files directory (what "Index a folder" reads), listed with each file's
 * modification time and size as its version marker. Read-only; never leaves the files directory (`folderFiles` and
 * `resolveInFilesDir` refuse a path or a symlink that leads out).
 */
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { SOURCE_LIMITS, type FolderSettings } from '../../../shared/knowledge-sources';
import { folderFiles } from '../../agents/knowledge';
import { resolveInFilesDir } from '../../nodes/files';
import { SourceError, type Connector, type SourceItem } from './types';

export function folderConnector(settings: FolderSettings): Connector {
  return {
    async list() {
      const listed = await folderFiles(settings.folder, SOURCE_LIMITS.listingEntries);
      const items: SourceItem[] = [];
      let unreadable = listed.incomplete;
      for (const file of listed.files) {
        try {
          const { path } = await resolveInFilesDir(file);
          const info = await stat(path);
          items.push({ key: file, name: basename(file), version: `${Math.round(info.mtimeMs)}:${info.size}`, size: info.size });
        } catch (caught) {
          // Gone since it was listed is a removal; anything else is a part we could not see.
          if ((caught as NodeJS.ErrnoException).code !== 'ENOENT') unreadable = true;
        }
      }
      const complete = !listed.truncated && !unreadable;
      return { items, complete, ...(!complete && { note: listed.truncated ? `The folder holds more than ${SOURCE_LIMITS.listingEntries} files` : 'Part of the folder could not be read' }) };
    },
    async fetch(item) {
      const { path } = await resolveInFilesDir(item.key);
      const info = await stat(path);
      if (info.size > SOURCE_LIMITS.fileBytes) throw new SourceError(`Too large (${Math.round(info.size / 1024 / 1024)} MB; the limit is ${SOURCE_LIMITS.fileBytes / 1024 / 1024} MB)`);
      return { bytes: new Uint8Array(await readFile(path)), fileName: item.name };
    },
  };
}
