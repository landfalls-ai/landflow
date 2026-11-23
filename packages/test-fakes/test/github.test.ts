/** The GitHub fake: branches, files committed on them, pull requests, comments; a stale sha is 409; no token is 401. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeGitHub } from '../src/github';

const github = fakeGitHub();
beforeAll(() => github.start());
afterAll(() => github.stop());
beforeEach(() => github.reset());

const call = async (method: string, path: string, body?: unknown, token: string | null = github.token) => {
  const response = await fetch(`${github.url}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), accept: 'application/vnd.github+json', 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as any };
};
const R = '/repos/acme/widgets';
const b64 = (text: string) => Buffer.from(text).toString('base64');
const main = () => github.state().repos['acme/widgets'];

describe('branches and files', () => {
  it('creates a branch from main, commits a file on it, and leaves main alone', async () => {
    const tip = (await call('GET', `${R}/git/ref/heads/main`)).body.object.sha;
    expect((await call('POST', `${R}/git/refs`, { ref: 'refs/heads/feature', sha: tip })).status).toBe(201);
    const put = await call('PUT', `${R}/contents/docs/new.md`, { message: 'Add new', content: b64('hello\n'), branch: 'feature' });
    expect(put.status).toBe(201);
    expect(main().branches).toEqual(expect.objectContaining({ main: expect.any(String), feature: expect.any(String) }));
    expect(main().files.feature['docs/new.md']).toBe('hello\n');
    expect(main().files.main['docs/new.md']).toBeUndefined();
    expect(main().files.feature['README.md']).toBe(main().files.main['README.md']);
    const read = await call('GET', `${R}/contents/docs/new.md?ref=feature`);
    expect(Buffer.from(read.body.content, 'base64').toString()).toBe('hello\n');
  });

  it('updates a file with its sha, and answers 409 for a stale one and 422 for a missing one', async () => {
    const sha = (await call('GET', `${R}/contents/README.md`)).body.sha;
    expect((await call('PUT', `${R}/contents/README.md`, { message: 'm', content: b64('v2'), sha })).status).toBe(200);
    expect(main().files.main['README.md']).toBe('v2');
    expect((await call('PUT', `${R}/contents/README.md`, { message: 'm', content: b64('v3'), sha })).status).toBe(409);
    expect((await call('PUT', `${R}/contents/README.md`, { message: 'm', content: b64('v3') })).status).toBe(422);
    expect(main().files.main['README.md']).toBe('v2');
  });

  it('refuses a branch that exists and a commit on a branch that does not', async () => {
    const tip = main().branches.main;
    expect((await call('POST', `${R}/git/refs`, { ref: 'refs/heads/main', sha: tip })).status).toBe(422);
    expect((await call('PUT', `${R}/contents/a.md`, { message: 'm', content: b64('x'), branch: 'ghost' })).status).toBe(404);
  });
});

describe('pull requests and comments', () => {
  it('opens a pull request from a branch with a commit, and comments on it', async () => {
    await call('POST', `${R}/git/refs`, { ref: 'refs/heads/feature', sha: main().branches.main });
    await call('PUT', `${R}/contents/a.md`, { message: 'Add a', content: b64('a'), branch: 'feature' });
    const pull = await call('POST', `${R}/pulls`, { title: 'Add a', head: 'feature', base: 'main', body: 'why' });
    expect(pull).toMatchObject({ status: 201, body: { number: 1, state: 'open', head: { ref: 'feature' }, base: { ref: 'main' } } });
    const comment = await call('POST', `${R}/issues/1/comments`, { body: 'LGTM' });
    expect(comment.status).toBe(201);
    expect(main().pulls).toMatchObject([{ number: 1, title: 'Add a', state: 'open', head: 'feature', base: 'main' }]);
    expect(main().comments).toMatchObject([{ number: 1, body: 'LGTM' }]);
    expect((await call('GET', `${R}/pulls/1`)).body.title).toBe('Add a');
    expect((await call('GET', `${R}/issues/1/comments`)).body).toHaveLength(1);
  });

  it('refuses a pull request from an unknown branch and a comment on nothing', async () => {
    expect((await call('POST', `${R}/pulls`, { title: 't', head: 'ghost', base: 'main' })).status).toBe(422);
    expect((await call('POST', `${R}/issues/9/comments`, { body: 'x' })).status).toBe(404);
  });
});

describe('auth, seed and unknown repos', () => {
  it('answers 401 without the token and leaves the state alone', async () => {
    expect((await call('PUT', `${R}/contents/a.md`, { message: 'm', content: b64('x') }, null)).status).toBe(401);
    expect((await call('PUT', `${R}/contents/a.md`, { message: 'm', content: b64('x') }, 'ghp_wrong')).status).toBe(401);
    expect(main().files.main['a.md']).toBeUndefined();
  });

  it('answers 404 for a repository it does not hold, and takes its own repositories from the seed', async () => {
    expect((await call('GET', '/repos/acme/other')).status).toBe(404);
    const own = fakeGitHub({ repos: { 'me/lib': { 'index.ts': 'export {};\n' } } });
    expect(Object.keys(own.state().repos)).toEqual(['me/lib']);
    expect(own.state().repos['me/lib'].files.main['index.ts']).toBe('export {};\n');
  });

  it('serves the same paths under /api/v3 (an Enterprise base URL)', async () => {
    expect((await call('GET', `/api/v3${R}`)).body.full_name).toBe('acme/widgets');
    expect((await call('GET', '/api/v3/user')).body.login).toBeTruthy();
  });
});
