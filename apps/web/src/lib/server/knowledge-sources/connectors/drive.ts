/**
 * C22: the Google Drive connector: the files of one folder (and, when asked, its subfolders, breadth first), listed with the Drive
 * API v3 and read with the person's own OAuth credential (Connect; a service account is not supported). Docs are exported as Markdown
 * (text when Google refuses it), Sheets as CSV, Slides as text; other files are downloaded and read by the loaders; shortcuts, forms
 * and files no loader reads are left out. Version marker: `md5Checksum` for a file, `modifiedTime` for a Google file.
 *
 * Every request goes through `safeFetch`. The API's address is Google's; `LANDFLOW_KNOWLEDGE_DRIVE_URL` points it at a local fake in
 * development and tests and is ignored (with one warning) in the production profile. A 401 renews the token once and retries; an error
 * keeps the status and Google's own message, never the token.
 */
import { SOURCE_LIMITS, type DriveSettings } from '../../../shared/knowledge-sources';
import { envUrl, isProduction } from '../../config';
import { credentials } from '../../credentials/vault';
import { safeFetch } from '../../net/safe-fetch';
import { fileKind } from '../../rag/files';
import { logger } from '../../telemetry/logger';
import { readCapped } from './bounded';
import { SourceError, type Connector, type SourceItem } from './types';

const GOOGLE = 'https://www.googleapis.com';
const DOC = 'application/vnd.google-apps.document';
const SHEET = 'application/vnd.google-apps.spreadsheet';
const SLIDES = 'application/vnd.google-apps.presentation';
const FOLDER = 'application/vnd.google-apps.folder';
const MAX_FOLDERS = 500;
const FIELDS = 'nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,size,webViewLink)';

/** Where the Drive API is: Google's, or in development and tests the address in LANDFLOW_KNOWLEDGE_DRIVE_URL. */
let warned = false;
export function driveBase(): string {
  const override = envUrl('LANDFLOW_KNOWLEDGE_DRIVE_URL');
  if (!override) return GOOGLE;
  if (isProduction()) {
    if (!warned) {
      warned = true;
      logger.warn('LANDFLOW_KNOWLEDGE_DRIVE_URL is ignored in the production profile: Google Drive sources call Google');
    }
    return GOOGLE;
  }
  return override.replace(/\/+$/, '');
}

export interface TokenSource {
  /** A token that is good now (renewed first when it is about to expire). */
  token(): Promise<string>;
  /** A new token after Google refused the last one. */
  renew(): Promise<string>;
}

/** The access token of a Connect'ed OAuth2 credential, kept fresh by the vault (`refreshOAuth2`). */
export function vaultTokens(credentialId: string): TokenSource {
  const read = (): string => {
    const found = credentials.list().find((c) => c.id === credentialId);
    if (!found) throw new SourceError('The Google credential was deleted');
    const token = credentials.dataFor({ id: credentialId, name: found.name }, found.type).accessToken;
    if (!token) throw new SourceError(`“${found.name}” is not connected: open it in Credentials and use Connect`);
    return String(token);
  };
  const refresh = async (force: boolean): Promise<string> => {
    try {
      await credentials.refreshOAuth2(credentialId, { force });
    } catch (caught) {
      throw new SourceError((caught as Error).message.slice(0, 300));
    }
    return read();
  };
  return { token: () => refresh(false), renew: () => refresh(true) };
}

interface DriveFileEntry {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  md5Checksum?: string;
  size?: string;
  webViewLink?: string;
}

export function driveConnector(settings: DriveSettings, tokens: TokenSource): Connector {
  let bearer: string | undefined;

  /** One API call; a 401 renews the token once and asks again. */
  async function call(path: string, signal: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      bearer ??= await tokens.token();
      let response: Response;
      try {
        response = await safeFetch(`${driveBase()}${path}`, { headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' }, signal });
      } catch (caught) {
        throw new SourceError(signal.aborted ? 'Stopped' : (caught as Error).message.slice(0, 300));
      }
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel().catch(() => undefined);
        bearer = await tokens.renew();
        continue;
      }
      if (response.ok) return response;
      const body = (await response.json().catch(() => undefined)) as { error?: { message?: string } } | undefined;
      throw new SourceError(`Google Drive answered ${response.status}${body?.error?.message ? `: ${body.error.message}` : ''}`.slice(0, 300));
    }
  }

  return {
    async list(signal) {
      const items: SourceItem[] = [];
      const folders = [settings.folderId];
      const seen = new Set(folders);
      let skipped = 0;
      let entries = 0;
      let complete = true;
      let note: string | undefined;
      while (folders.length) {
        const folder = folders.shift()!;
        let pageToken: string | undefined;
        do {
          const query = new URLSearchParams({ q: `'${folder}' in parents and trashed = false`, fields: FIELDS, pageSize: '1000', ...(pageToken && { pageToken }) });
          const page = (await (await call(`/drive/v3/files?${query}`, signal)).json()) as { files?: DriveFileEntry[]; nextPageToken?: string };
          for (const f of page.files ?? []) {
            if (++entries > SOURCE_LIMITS.listingEntries) {
              complete = false;
              note = `The folder holds more than ${SOURCE_LIMITS.listingEntries} entries`;
              break;
            }
            if (f.mimeType === FOLDER) {
              if (settings.includeSubfolders && !seen.has(f.id)) {
                if (seen.size >= MAX_FOLDERS) {
                  complete = false;
                  note = `More than ${MAX_FOLDERS} folders`;
                } else {
                  seen.add(f.id);
                  folders.push(f.id);
                }
              }
              continue;
            }
            const base = { key: f.id, ...(f.webViewLink && { url: f.webViewLink }) };
            if (f.mimeType === DOC) items.push({ ...base, name: `${f.name}.md`, version: f.modifiedTime ?? '', mimeType: f.mimeType });
            else if (f.mimeType === SHEET) items.push({ ...base, name: `${f.name}.csv`, version: f.modifiedTime ?? '', mimeType: f.mimeType });
            else if (f.mimeType === SLIDES) items.push({ ...base, name: `${f.name}.txt`, version: f.modifiedTime ?? '', mimeType: f.mimeType });
            else if (f.mimeType.startsWith('application/vnd.google-apps.')) skipped++; // a shortcut, a form, a drawing: nothing to read
            else if (fileKind({ bytes: new Uint8Array(0), fileName: f.name, mimeType: f.mimeType })) items.push({ ...base, name: f.name, version: f.md5Checksum ?? f.modifiedTime ?? '', mimeType: f.mimeType, ...(f.size && { size: Number(f.size) }) });
          }
          pageToken = complete ? page.nextPageToken : undefined;
        } while (pageToken);
        if (!complete) break;
      }
      return { items, complete, ...(note && { note }), ...(skipped && { skipped }) };
    },

    async fetch(item, signal) {
      const id = encodeURIComponent(item.key);
      const native = item.mimeType === DOC || item.mimeType === SHEET || item.mimeType === SLIDES;
      let response: Response;
      if (native) {
        const wanted = item.mimeType === SHEET ? 'text/csv' : item.mimeType === SLIDES ? 'text/plain' : 'text/markdown';
        try {
          response = await call(`/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(wanted)}`, signal);
        } catch (caught) {
          // Markdown export is newer than the others: a Doc Google will not give as Markdown is read as text.
          if (wanted !== 'text/markdown' || !/answered 400/.test((caught as Error).message)) throw caught;
          response = await call(`/drive/v3/files/${id}/export?mimeType=text%2Fplain`, signal);
        }
      } else {
        if ((item.size ?? 0) > SOURCE_LIMITS.fileBytes) throw new SourceError(`Too large (${Math.round((item.size ?? 0) / 1024 / 1024)} MB; the limit is ${SOURCE_LIMITS.fileBytes / 1024 / 1024} MB)`);
        response = await call(`/drive/v3/files/${id}?alt=media`, signal);
      }
      const bytes = await readCapped(response.body, SOURCE_LIMITS.fileBytes); // counted after decompression; past the cap the rest is never read
      return { bytes, fileName: item.name, ...(!native && item.mimeType && { mimeType: item.mimeType }) };
    },
  };
}
