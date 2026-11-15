/**
 * Who last changed a credential (`createdBy` / `updatedBy` in lib/server/credentials/vault.ts, "Last changed by" in the
 * credential dialog), through the credential routes: only a save that changes a value records its actor; a rename, a
 * rate limit, an unchanged form, a key rotation and a token operation by someone else (Refresh now, Connect, Disconnect)
 * never make them the last changer; a token operation does make its actor the last changer; the fields a type fixes
 * (hidden fields) cannot be set through the API. Moved here from the briefing tests: Deliver Briefing no longer reads
 * any credential (docs/work-and-briefings.md#the-nightly-sync).
 */
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { startFakeOAuth2 } from './fake-oauth2';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-credential-changer-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { createUser } = await import('@/lib/server/auth/users');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { credentials: vault } = await import('@/lib/server/credentials/vault');
const { createTeamProject, setHomeProject, setMember } = await import('@/lib/server/projects/store');
const credentialRoute = await import('@/app/api/credentials/[id]/route');
const tokenRoute = await import('@/app/api/credentials/[id]/oauth2/token/route');
const authorizeRoute = await import('@/app/api/credentials/[id]/oauth2/authorize/route');
const callbackRoute = await import('@/app/api/oauth2/callback/route');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { defineCredentialType, definePlugin } = await import('@landflow/sdk');

// The OAuth2 provider of the Slack OAuth2 type below (Slack's own in the real plugin).
const provider = await startFakeOAuth2({ expiresIn: 3600 });
const fixed = (name: string, displayName: string, value: string) => ({ name, displayName, type: 'hidden' as const, default: value });
registry.registerBuiltin(corePlugin);
// Slack's credential types (the messaging plugin isn't loaded here): the OAuth2 one fixes its grant and URLs in hidden
// fields, as plugins/messaging/src/nodes/slack.ts does.
registry.registerBuiltin(
  definePlugin({
    info: { id: 'messaging', name: 'Messaging', version: '1.0.0', language: 'typescript' },
    credentialTypes: [
      defineCredentialType({
        name: 'slackApi',
        displayName: 'Slack API',
        properties: [
          { name: 'accessToken', displayName: 'Access Token', type: 'string', required: true, typeOptions: { password: true } },
          { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: 'https://slack.com/api' },
        ],
      }),
      defineCredentialType({
        name: 'slackOAuth2Api',
        displayName: 'Slack OAuth2 API',
        extends: ['oAuth2Api'],
        properties: [
          fixed('grantType', 'Grant Type', 'authorizationCode'),
          fixed('authUrl', 'Authorization URL', `${provider.url}/authorize`),
          fixed('accessTokenUrl', 'Access Token URL', `${provider.url}/token`),
          fixed('authentication', 'Client Authentication', 'body'),
          { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: 'https://slack.com/api' },
        ],
      }),
    ],
    nodes: [],
  }),
);

const owner = await createUser({ email: 'owner@changer.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
const alice = await createUser({ email: 'alice@changer.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
const team = createTeamProject({ name: 'Platform', createdBy: owner.id });
setMember(team.id, alice.id, 'editor');
const SLACK = 'https://slack.com/api';

afterAll(async () => {
  await provider.close();
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

type AnyUser = typeof owner;
/** Call a route as `user` (the suite's synthetic owner again afterwards). */
const asUser = async <T,>(user: AnyUser, fn: () => Promise<T>): Promise<T> => {
  enableTestAuth(user);
  try {
    return await fn();
  } finally {
    enableTestAuth();
  }
};
const patch = (user: AnyUser, id: string, body: Record<string, unknown>) =>
  asUser(user, () => credentialRoute.PATCH(new Request(`http://landflow.test/api/credentials/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) }));
/** Get token / Refresh now (POST) or Disconnect (DELETE), through the route. */
const token = (user: AnyUser, method: 'POST' | 'DELETE', id: string) =>
  asUser(user, () => tokenRoute[method](new Request(`http://landflow.test/api/credentials/${id}/oauth2/token`, { method }), { params: Promise.resolve({ id }) }));
/** Connect through the routes, as a browser would: authorize (as `user`) → the provider's consent → the public callback. */
const connect = async (user: AnyUser, id: string) => {
  const start = await asUser(user, () => authorizeRoute.GET(new Request(`http://landflow.test/api/credentials/${id}/oauth2/authorize`), { params: Promise.resolve({ id }) }));
  expect(start.status).toBe(302);
  const consent = await fetch(new URL(start.headers.get('location')!), { redirect: 'manual' });
  const page = await callbackRoute.GET(new Request(new URL(consent.headers.get('location')!), { headers: { cookie: start.headers.get('set-cookie')!.split(';')[0] } }));
  expect(page.status).toBe(200);
};
/** A server that records what reaches it. */
const recordingServer = async () => {
  const got: string[] = [];
  const server = createServer((request, response) => {
    got.push(request.url ?? '');
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  });
  const url = await new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
  return { got, url, close: () => server.close() };
};

describe('a token credential', () => {
  // In the team, so Alice (an editor there) may change it through the route.
  const key = vault.create({ name: 'Team Slack', type: 'messaging.slackApi', data: { accessToken: 'xoxb-dev-only', baseUrl: SLACK } }, { actor: owner.id });
  setHomeProject('credential', key.id, team.id);

  it('a member’s change makes her the last changer, and the route answers with it', async () => {
    const response = await patch(alice, key.id, { data: { baseUrl: 'http://127.0.0.1:9/api' } });
    expect(response.status).toBe(200);
    expect(vault.lastChangedBy(key.id)).toBe(alice.id);
    expect(((await response.json()) as { credential: { updatedBy?: string } }).credential.updatedBy).toBe(alice.id);
  });

  it('an owner’s empty save, unchanged form, rename or rate limit vouches for nothing; a real change does', async () => {
    expect((await patch(alice, key.id, { data: { baseUrl: 'http://127.0.0.1:9/api' } })).status).toBe(200);
    expect(vault.lastChangedBy(key.id)).toBe(alice.id);
    // The secret left empty keeps its value.
    for (const body of [{ data: {} }, { name: 'Team Slack', data: { baseUrl: 'http://127.0.0.1:9/api', accessToken: '' }, rateLimit: null }, { name: 'Team Slack (renamed)' }, { rateLimit: { limit: 5, intervalSeconds: 1 } }]) {
      expect((await patch(owner, key.id, body)).status).toBe(200);
      expect(vault.lastChangedBy(key.id)).toBe(alice.id);
    }
    const saved = await patch(owner, key.id, { data: { baseUrl: SLACK } });
    expect(vault.lastChangedBy(key.id)).toBe(owner.id);
    expect(((await saved.json()) as { credential: { updatedByName?: string } }).credential.updatedByName).toBe('Owner');
    // A member's save that changes nothing leaves it so.
    expect((await patch(alice, key.id, { data: { baseUrl: SLACK, accessToken: '' } })).status).toBe(200);
    expect(vault.lastChangedBy(key.id)).toBe(owner.id);
  });

  it('a rename by a member or a key rotation keeps who changed it', async () => {
    expect((await patch(owner, key.id, { data: { accessToken: 'xoxb-dev-only-2' } })).status).toBe(200);
    expect(vault.lastChangedBy(key.id)).toBe(owner.id);
    expect((await patch(alice, key.id, { name: 'Team Slack (renamed again)' })).status).toBe(200);
    expect(vault.rotateCredentials().failed).toEqual([]);
    expect(vault.lastChangedBy(key.id)).toBe(owner.id);
  });

  it('a credential from before migration 2092, or a change with no person behind it, records nobody', () => {
    const legacy = vault.create({ name: 'Old Slack', type: 'messaging.slackApi', data: { accessToken: 'xoxb-dev-only', baseUrl: SLACK } });
    expect(vault.lastChangedBy(legacy.id)).toBeUndefined();
    vault.update(key.id, { data: { accessToken: 'xoxb-dev-only-3' } });
    expect(vault.lastChangedBy(key.id)).toBeUndefined();
    vault.update(key.id, { data: { accessToken: 'xoxb-dev-only' } }, { actor: owner.id });
    expect(vault.lastChangedBy(key.id)).toBe(owner.id);
  });
});

describe('an OAuth2 credential: token operations', () => {
  const oauth = vault.create({ name: 'Team Slack OAuth2', type: 'messaging.slackOAuth2Api', data: { clientId: 'client-1', clientSecret: 'secret-1', baseUrl: SLACK } }, { actor: owner.id });
  setHomeProject('credential', oauth.id, team.id);
  const vouch = async (scope: string) => {
    expect((await patch(owner, oauth.id, { data: { scope } })).status).toBe(200);
    expect(vault.lastChangedBy(oauth.id)).toBe(owner.id);
  };

  it('after a member’s change, an owner’s Refresh now, Disconnect and Connect leave her the last changer', async () => {
    await connect(owner, oauth.id);
    expect(vault.oauth2(oauth.id).token?.access_token).toBeTruthy();
    expect(vault.lastChangedBy(oauth.id)).toBe(owner.id);
    expect((await patch(alice, oauth.id, { data: { baseUrl: 'http://127.0.0.1:9/api' } })).status).toBe(200);
    expect(vault.lastChangedBy(oauth.id)).toBe(alice.id);
    expect((await token(owner, 'POST', oauth.id)).status).toBe(200);
    expect(vault.lastChangedBy(oauth.id)).toBe(alice.id);
    expect((await token(owner, 'DELETE', oauth.id)).status).toBe(200);
    expect(vault.lastChangedBy(oauth.id)).toBe(alice.id);
    await connect(owner, oauth.id);
    expect(vault.lastChangedBy(oauth.id)).toBe(alice.id);
    // An owner's real change makes them the last changer again.
    expect((await patch(owner, oauth.id, { data: { baseUrl: SLACK } })).status).toBe(200);
    expect(vault.lastChangedBy(oauth.id)).toBe(owner.id);
  });

  it('a member’s Refresh now, Connect or Disconnect makes her the last changer; an automatic refresh keeps it', async () => {
    await connect(owner, oauth.id);
    await vouch('chat:write');
    expect((await token(alice, 'POST', oauth.id)).status).toBe(200);
    expect(vault.lastChangedBy(oauth.id)).toBe(alice.id);
    await vouch('chat:write,users:read.email');
    await connect(alice, oauth.id);
    expect(vault.lastChangedBy(oauth.id)).toBe(alice.id);
    await vouch('chat:write');
    expect((await token(alice, 'DELETE', oauth.id)).status).toBe(200);
    expect(vault.lastChangedBy(oauth.id)).toBe(alice.id);
    await vouch('chat:write,users:read.email');
    await connect(owner, oauth.id);
    expect(await vault.refreshOAuth2(oauth.id, { force: true })).toBe(true);
    expect(vault.lastChangedBy(oauth.id)).toBe(owner.id);
  });

  it('the fields the type fixes (grant, authorization and token URLs) cannot be set through the API, nor on create', async () => {
    const evil = await recordingServer();
    try {
      await vouch('chat:write');
      const response = await patch(alice, oauth.id, { data: { grantType: 'clientCredentials', authUrl: `${evil.url}/authorize`, accessTokenUrl: `${evil.url}/token`, authentication: 'header' } });
      expect(response.status).toBe(200);
      // Nothing changed: the type's values stand, and the owner is still the last changer.
      expect(vault.oauth2(oauth.id).config).toMatchObject({ grantType: 'authorizationCode', authUrl: `${provider.url}/authorize`, accessTokenUrl: `${provider.url}/token` });
      expect(vault.lastChangedBy(oauth.id)).toBe(owner.id);
      expect(vault.get(oauth.id)!.data).not.toHaveProperty('accessTokenUrl');
      const made = vault.create({ name: 'Made', type: 'messaging.slackOAuth2Api', data: { clientId: 'c', accessTokenUrl: `${evil.url}/token`, baseUrl: SLACK } }, { actor: alice.id });
      expect(vault.oauth2(made.id).config.accessTokenUrl).toBe(`${provider.url}/token`);
      vault.delete(made.id);
      expect(evil.got).toEqual([]);
    } finally {
      evil.close();
    }
  });
});
