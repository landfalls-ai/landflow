/**
 * A stateful Google Drive (API v3, the read side a knowledge source needs): folders and files with `modifiedTime` and, for
 * binary files, `md5Checksum`; `files.list` with a `'<folder>' in parents and trashed = false` query, `fields`, `pageSize` and
 * `pageToken`; `files.get?alt=media` for files; `files.export` for Google Docs (`text/markdown`, `text/plain`), Sheets (`text/csv`)
 * and Slides (`text/plain`). Every request needs `Authorization: Bearer <a token the fake accepts>` (401 otherwise, in Google's error
 * shape), so a test sees a credential that was not renewed: `acceptOnly(fake, token)` makes the old token stop working.
 *
 * Seed files carry their `content` (text). Native Google types: `application/vnd.google-apps.document|spreadsheet|presentation|folder|
 * shortcut|form`. `markdownExport: false` makes Docs refuse the Markdown export (400) so a client's fallback to text can be tested.
 * Use `putFile` / `removeFile` (the fake's own `/__fake/*` controls) to change the Drive mid-test; a put sets a new `modifiedTime`.
 */
import { createHash } from 'node:crypto';
import { defineFake, type Fake, type FakeReply, type FakeRequest } from './harness';

export const DRIVE_TOKEN = 'ya29.fake-drive-access-token';

export const DOC = 'application/vnd.google-apps.document';
export const SHEET = 'application/vnd.google-apps.spreadsheet';
export const SLIDES = 'application/vnd.google-apps.presentation';
export const FOLDER = 'application/vnd.google-apps.folder';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** Folder ids. */
  parents: string[];
  content?: string;
  modifiedTime: string;
  trashed?: boolean;
}

export interface DriveState {
  files: Record<string, DriveFile>;
  /** The bearer tokens the fake accepts. */
  tokens: string[];
  markdownExport: boolean;
}

export interface DriveSeed {
  token: string;
  files: DriveFile[];
  markdownExport: boolean;
}

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
const file = (id: string, name: string, mimeType: string, parents: string[], content: string | undefined, minutes: number): DriveFile => ({ id, name, mimeType, parents, ...(content !== undefined && { content }), modifiedTime: at(minutes) });

/** A folder `root-folder` with two Docs and a PDF-less text file, and a subfolder with a Doc and a Sheet. */
export const defaultDriveFiles = (): DriveFile[] => [
  file('folder-top', 'Handbook', FOLDER, ['root'], undefined, 0),
  file('doc-onboarding', 'Onboarding', DOC, ['folder-top'], '# Onboarding\n\nWelcome. Get your laptop on day one.\n', 1),
  file('doc-expenses', 'Expenses', DOC, ['folder-top'], '# Expenses\n\nFile receipts within 30 days.\n', 2),
  file('txt-holidays', 'holidays.txt', 'text/plain', ['folder-top'], 'Company holidays: the first Monday of May.\n', 3),
  file('folder-sub', 'Teams', FOLDER, ['folder-top'], undefined, 4),
  file('doc-oncall', 'On call', DOC, ['folder-sub'], '# On call\n\nPage the on-call engineer first.\n', 5),
  file('sheet-rota', 'Rota', SHEET, ['folder-sub'], 'week,person\n1,Ana\n2,Ben\n', 6),
  file('link-old', 'Old handbook', 'application/vnd.google-apps.shortcut', ['folder-top'], undefined, 7),
];

const md5 = (text: string) => createHash('md5').update(text).digest('hex');
const isNative = (type: string) => type.startsWith('application/vnd.google-apps.');
const bad = (status: number, message: string, reason: string): FakeReply => ({ status, body: { error: { code: status, message, errors: [{ reason, message }], status: reason.toUpperCase() } } });

function metadata(f: DriveFile, host: string) {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
    parents: f.parents,
    ...(f.content !== undefined && !isNative(f.mimeType) && { md5Checksum: md5(f.content), size: String(Buffer.byteLength(f.content)) }),
    ...(f.mimeType !== FOLDER && { webViewLink: `https://drive.example.test/${host}/${f.id}/view` }),
  };
}

function route(state: DriveState, request: FakeRequest): FakeReply {
  const bearer = String(request.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!request.path.startsWith('/__fake/') && !state.tokens.includes(bearer) && !(state.tokens.includes('*') && bearer)) return bad(401, 'Invalid Credentials', 'authError');
  if (request.method === 'PUT' && request.path === '/__fake/file') {
    const f = request.body as DriveFile;
    state.files[f.id] = { ...f, modifiedTime: new Date().toISOString() };
    return { status: 204, body: '' };
  }
  if (request.method === 'DELETE' && request.path === '/__fake/file') {
    delete state.files[request.query.get('id') ?? ''];
    return { status: 204, body: '' };
  }
  if (request.method === 'PUT' && request.path === '/__fake/tokens') {
    state.tokens = (request.body as { tokens: string[] }).tokens;
    return { status: 204, body: '' };
  }
  const host = String(request.headers.host ?? '');
  if (request.method === 'GET' && request.path === '/drive/v3/files') {
    const q = request.query.get('q') ?? '';
    const parent = /^'([^']+)' in parents and trashed = false$/.exec(q)?.[1];
    if (!parent) return bad(400, 'Invalid Value', 'invalid');
    const size = Math.min(1000, Number(request.query.get('pageSize') ?? 100) || 100);
    const after = request.query.get('pageToken') ?? '';
    const all = Object.values(state.files).filter((f) => f.parents.includes(parent) && !f.trashed).sort((a, b) => a.id.localeCompare(b.id)).filter((f) => f.id > after);
    const page = all.slice(0, size);
    return { body: { kind: 'drive#fileList', files: page.map((f) => metadata(f, host)), ...(all.length > size && { nextPageToken: page[page.length - 1].id }) } };
  }
  const exportMatch = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(request.path);
  if (request.method === 'GET' && exportMatch) {
    const f = state.files[decodeURIComponent(exportMatch[1])];
    if (!f) return bad(404, 'File not found', 'notFound');
    const wanted = request.query.get('mimeType') ?? '';
    const allowed = f.mimeType === DOC ? ['text/plain', ...(state.markdownExport ? ['text/markdown'] : [])] : f.mimeType === SHEET ? ['text/csv'] : f.mimeType === SLIDES ? ['text/plain'] : [];
    if (!allowed.includes(wanted)) return bad(400, 'Export only supports Docs Editors files.', 'invalid');
    return { headers: { 'content-type': wanted }, body: f.content ?? '' };
  }
  const getMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(request.path);
  if (request.method === 'GET' && getMatch) {
    const f = state.files[decodeURIComponent(getMatch[1])];
    if (!f) return bad(404, 'File not found', 'notFound');
    if (request.query.get('alt') !== 'media') return { body: metadata(f, host) };
    if (isNative(f.mimeType)) return bad(403, 'Only files with binary content can be downloaded. Use Export with Docs Editors files.', 'fileNotDownloadable');
    return { headers: { 'content-type': f.mimeType, 'content-length': String(Buffer.byteLength(f.content ?? '')) }, body: f.content ?? '' };
  }
  return bad(404, 'Not Found', 'notFound');
}

export function fakeDrive(seed: Partial<DriveSeed> = {}): Fake<DriveState> {
  const token = seed.token ?? DRIVE_TOKEN;
  return defineFake<DriveState>({
    name: 'drive',
    token,
    auth: () => true, // the routes check the bearer themselves, so that the accepted tokens live in the state (a renewed token replaces the old one)
    scriptBody: (script) => ({ error: { code: script.status, message: 'scripted', errors: [{ reason: 'backendError' }] } }),
    initial: () => ({ files: Object.fromEntries((seed.files ?? defaultDriveFiles()).map((f) => [f.id, structuredClone(f)])), tokens: [token], markdownExport: seed.markdownExport ?? true }),
    routes: route,
  });
}

const authed = (fake: Fake<DriveState>, token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

/** Add or replace a file (its `modifiedTime` becomes now), through the fake's own control route. */
export async function putFile(fake: Fake<DriveState>, f: Omit<DriveFile, 'modifiedTime'> & { modifiedTime?: string }): Promise<void> {
  const response = await fetch(`${fake.url}/__fake/file`, { method: 'PUT', headers: authed(fake, fake.token), body: JSON.stringify({ modifiedTime: '', ...f }) });
  if (!response.ok) throw new Error(`putFile: ${response.status}`);
}

/** Remove a file for good (it is not listed or readable any more). */
export async function removeFile(fake: Fake<DriveState>, id: string): Promise<void> {
  const response = await fetch(`${fake.url}/__fake/file?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers: authed(fake, fake.token) });
  if (!response.ok) throw new Error(`removeFile: ${response.status}`);
}

/** The fake accepts only these bearer tokens from now on (a renewed token, the old one expired); `'*'` accepts any non-empty token. */
export async function acceptOnly(fake: Fake<DriveState>, ...tokens: string[]): Promise<void> {
  const response = await fetch(`${fake.url}/__fake/tokens`, { method: 'PUT', headers: authed(fake, fake.token), body: JSON.stringify({ tokens }) });
  if (!response.ok) throw new Error(`acceptOnly: ${response.status}`);
}
