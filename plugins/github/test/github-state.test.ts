/**
 * The GitHub node against the stateful GitHub fake (@landflow/test-fakes): a file commit and a pull request land in the
 * repository state. The older fake-github.ts and the request-shape tests in github.test.ts stay.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@landflow/sdk';
import { fakeGitHub } from '@landflow/test-fakes/github';
import { GitHub } from '../src/nodes/github';
import { run } from './helpers';

const github = fakeGitHub();
beforeAll(() => github.start());
afterAll(() => github.stop());
beforeEach(() => github.reset());

const credentials = (token = github.token) => ({ githubApi: { accessToken: token, baseUrl: `${github.url}/api/v3/` } });
const call = (parameters: JsonObject, token?: string) => run(GitHub, { owner: 'acme', repository: 'widgets', ...parameters }, { credentials: credentials(token) });
const repo = () => github.state().repos['acme/widgets'];

describe('GitHub file and pull request', () => {
  it('commits a file on a new branch and opens a pull request from it', async () => {
    expect((await call({ resource: 'branch', operation: 'create', branch: 'feature' })).error).toBeUndefined();
    const file = await call({ resource: 'file', operation: 'createOrUpdate', path: 'docs/new.md', content: 'hello\n', message: 'Add new', branch: 'feature' });
    expect(file.error).toBeUndefined();
    expect(repo().files.feature['docs/new.md']).toBe('hello\n');
    expect(repo().files.main['docs/new.md']).toBeUndefined();

    const pull = await call({ resource: 'pullRequest', operation: 'create', title: 'Add new', head: 'feature', base: 'main', draft: false });
    expect(pull.error).toBeUndefined();
    expect(repo().pulls).toMatchObject([{ number: 1, title: 'Add new', state: 'open', head: 'feature', base: 'main', draft: false }]);

    expect((await call({ resource: 'pullRequest', operation: 'comment', pullNumber: 1, commentBody: 'Ready' })).error).toBeUndefined();
    expect(repo().comments).toMatchObject([{ number: 1, body: 'Ready' }]);
  });

  it('updates an existing file in one call (the node reads its sha first)', async () => {
    const response = await call({ resource: 'file', operation: 'createOrUpdate', path: 'README.md', content: '# Widgets v2\n', message: 'Update readme' });
    expect(response.error).toBeUndefined();
    expect(repo().files.main['README.md']).toBe('# Widgets v2\n');
  });

  it('with a wrong token nothing lands and the node says so', async () => {
    const response = await call({ resource: 'file', operation: 'createOrUpdate', path: 'x.md', content: 'x', message: 'x' }, 'ghp_wrong');
    expect(response.error?.message).toMatch(/401|credentials/i);
    expect(repo().files.main['x.md']).toBeUndefined();
    expect(github.requests().every((r) => r.refused)).toBe(true);
  });
});
