/**
 * Where a linked project's objects live in Notion (docs/features/notion-brain.md): the URL of the Notion row a local page, fact,
 * practice or note was copied to, for the Brain page's "Open in Notion" and the brain MCP's `notionUrl`. Reads the local tables
 * only, never Notion. A disconnected link and a row trashed in Notion (`detached`) give none. The caller checks that the viewer
 * may read the object; this only says where it lives.
 *
 * Wave nb3: NB07 owns it (backbone/contracts/nb/notion-urls.ts); NB08 adds it byte for byte. Change it in the contract first.
 */
import { database } from '../../db';
import { getLink } from './links';
import type { ItemKind } from './sync';

/** `https://www.notion.so/<id without dashes>`, the form the render contract's mentions use. */
export const notionPageUrl = (id: string): string => `https://www.notion.so/${id.replace(/-/g, '').toLowerCase()}`;

/** At most this many keys in one query (SQLite's and Postgres's parameter limits are far above it). */
const CHUNK = 500;

/**
 * The Notion URLs of `keys` (an item's `local_key`: `<type>/<id>` for a page, the id for a fact, practice or note) in the
 * project's link, by key. Keys with no row, or with a row trashed in Notion, are left out; an unlinked project gives none.
 */
export function mappedNotionUrls(projectId: string | null | undefined, kind: ItemKind, keys: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!projectId || !keys.length) return out;
  const link = getLink(projectId);
  if (!link) return out;
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const rows = database().all<{ local_key: string; notion_id: string }>(
      `SELECT local_key, notion_id FROM notion_brain_items WHERE link_id = ? AND kind = ? AND state <> 'detached' AND local_key IN (${chunk.map(() => '?').join(', ')})`,
      link.id,
      kind,
      ...chunk,
    );
    for (const row of rows) out.set(row.local_key, notionPageUrl(row.notion_id));
  }
  return out;
}

/** One object's Notion URL, or undefined. */
export const mappedNotionUrl = (projectId: string | null | undefined, kind: ItemKind, key: string): string | undefined =>
  mappedNotionUrls(projectId, kind, [key]).get(key);
