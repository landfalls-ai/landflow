/** The Drive fake: listing a folder's children, paging, media download, Docs export (Markdown, with a switch to refuse it), Sheets as CSV, a changed file moves its modifiedTime, a token that is not accepted is Google's 401. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acceptOnly, fakeDrive, putFile, removeFile, DOC } from '../src/drive';

const drive = fakeDrive();
beforeAll(() => drive.start());
afterAll(() => drive.stop());
beforeEach(() => drive.reset());

const get = (path: string, token = drive.token) => fetch(`${drive.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
const list = async (folder: string, extra = '') => (await (await get(`/drive/v3/files?q=${encodeURIComponent(`'${folder}' in parents and trashed = false`)}${extra}`)).json()) as { files: Array<Record<string, any>>; nextPageToken?: string };

describe('listing and reading', () => {
  it('lists the children of a folder only, with md5 for binary files and none for Docs', async () => {
    const top = await list('folder-top');
    expect(top.files.map((f) => f.id)).toEqual(['doc-expenses', 'doc-onboarding', 'folder-sub', 'link-old', 'txt-holidays']);
    expect(top.files.find((f) => f.id === 'txt-holidays')!.md5Checksum).toMatch(/^[0-9a-f]{32}$/);
    expect(top.files.find((f) => f.id === 'doc-expenses')!.md5Checksum).toBeUndefined();
    expect((await list('folder-sub')).files.map((f) => f.id)).toEqual(['doc-oncall', 'sheet-rota']);
  });
  it('pages with pageSize and pageToken', async () => {
    const first = await list('folder-top', '&pageSize=2');
    expect(first.files).toHaveLength(2);
    const second = await list('folder-top', `&pageSize=2&pageToken=${first.nextPageToken}`);
    expect(second.files[0].id).toBe('folder-sub');
  });
  it('exports a Doc as Markdown (or refuses, when told to), a Sheet as CSV, and downloads a text file', async () => {
    expect(await (await get('/drive/v3/files/doc-expenses/export?mimeType=text%2Fmarkdown')).text()).toContain('# Expenses');
    expect(await (await get('/drive/v3/files/sheet-rota/export?mimeType=text%2Fcsv')).text()).toContain('1,Ana');
    expect(await (await get('/drive/v3/files/txt-holidays?alt=media')).text()).toContain('first Monday of May');
    expect((await get('/drive/v3/files/doc-expenses?alt=media')).status).toBe(403);
    const strict = fakeDrive({ markdownExport: false });
    await strict.start();
    expect((await fetch(`${strict.url}/drive/v3/files/doc-expenses/export?mimeType=text%2Fmarkdown`, { headers: { authorization: `Bearer ${strict.token}` } })).status).toBe(400);
    await strict.stop();
  });
});

describe('changes and tokens', () => {
  it('a put moves modifiedTime, a remove takes the file away', async () => {
    const before = (await list('folder-top')).files.find((f) => f.id === 'doc-expenses')!.modifiedTime;
    await putFile(drive, { id: 'doc-expenses', name: 'Expenses', mimeType: DOC, parents: ['folder-top'], content: '# Expenses\n\nNew rules.\n' });
    expect((await list('folder-top')).files.find((f) => f.id === 'doc-expenses')!.modifiedTime).not.toBe(before);
    await removeFile(drive, 'doc-onboarding');
    expect((await list('folder-top')).files.map((f) => f.id)).not.toContain('doc-onboarding');
  });
  it('answers Google’s 401 to a token it does not accept, and accepts a replacement', async () => {
    await acceptOnly(drive, 'ya29.renewed');
    const refused = await get('/drive/v3/files/doc-expenses');
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as any).error.message).toBe('Invalid Credentials');
    expect((await get('/drive/v3/files/doc-expenses', 'ya29.renewed')).status).toBe(200);
  });
});
