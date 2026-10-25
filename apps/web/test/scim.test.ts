/**
 * SCIM 2.0 provisioning (lib/server/scim, app/scim/v2): the request sequences Okta and Entra ID send
 * (test/fixtures/scim/*.json) replayed through the route handlers, with the Landflow user checked after each step;
 * then SCIM tokens (scope, role, deactivated owner), discovery, filters and pagination, deactivation (sign-out, no
 * password sign-in, no API keys), group mappings (project memberships, admin role, same-name team projects, the
 * owner left alone) and DELETE moving what the user owned to the owner. The test bypass is off: every request
 * carries a real session or token.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-scim-'));
const ENV: Record<string, string> = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const UNSET = ['LANDFLOW_OWNER_EMAIL', 'LANDFLOW_OWNER_PASSWORD', 'LANDFLOW_SMTP_HOST', 'LANDFLOW_PUBLIC_URL', 'LANDFLOW_SECURE_COOKIES', 'LANDFLOW_SCIM_GROUP_MAP', 'LANDFLOW_LOGIN_MAX_ATTEMPTS'];
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);
for (const key of UNSET) delete process.env[key];

const auth = await import('@/lib/server/auth');
const { createApiKey } = await import('@/lib/server/auth/api-keys');
const projects = await import('@/lib/server/projects');
const { personalProjectId } = await import('@/lib/shared/projects');
const { parseFilter, matches } = await import('@/lib/server/scim/filter');
const { scimGroupMap, describeGroupMap } = await import('@/lib/server/scim/groups');

const setupRoute = await import('@/app/api/auth/setup/route');
const loginRoute = await import('@/app/api/auth/login/route');
const meRoute = await import('@/app/api/auth/me/route');
const apiKeysRoute = await import('@/app/api/api-keys/route');
const workflowsRoute = await import('@/app/api/workflows/route');
const securityRoute = await import('@/app/api/settings/security/route');
const usersRoute = await import('@/app/scim/v2/Users/route');
const userRoute = await import('@/app/scim/v2/Users/[id]/route');
const groupsRoute = await import('@/app/scim/v2/Groups/route');
const groupRoute = await import('@/app/scim/v2/Groups/[id]/route');
const spcRoute = await import('@/app/scim/v2/ServiceProviderConfig/route');
const schemasRoute = await import('@/app/scim/v2/Schemas/route');
const schemaRoute = await import('@/app/scim/v2/Schemas/[id]/route');
const typesRoute = await import('@/app/scim/v2/ResourceTypes/route');
const typeRoute = await import('@/app/scim/v2/ResourceTypes/[id]/route');

beforeAll(() => auth.disableTestAuth());
afterAll(() => {
  auth.enableTestAuth();
  for (const key of [...Object.keys(ENV), ...UNSET]) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

// ---- helpers -----------------------------------------------------------------------------------------------

const BASE = 'http://localhost:3000';
type Handler = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Options = { method?: string; body?: unknown; session?: string; bearer?: string; key?: string; headers?: Record<string, string> };

let ip = 0;
function request(path: string, options: Options = {}): Request {
  const headers: Record<string, string> = { 'x-forwarded-for': `10.1.0.${(ip++ % 250) + 1}`, ...options.headers };
  if (options.body !== undefined) headers['content-type'] ??= 'application/json';
  if (options.session) headers.cookie = `landflow_session=${options.session}`;
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  if (options.key) headers['x-landflow-api-key'] = options.key;
  return new Request(`${BASE}${path}`, { method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'), headers, ...(options.body !== undefined && { body: JSON.stringify(options.body) }) });
}

async function call(route: unknown, path: string, options: Options = {}, params?: Record<string, string>) {
  const response = await (route as Handler)(request(path, options), params && { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as Record<string, any>, headers: response.headers };
}

const SCIM_ROUTES: Array<{ pattern: RegExp; module: Record<string, unknown> }> = [
  { pattern: /^\/scim\/v2\/Users$/, module: usersRoute },
  { pattern: /^\/scim\/v2\/Users\/([^/]+)$/, module: userRoute },
  { pattern: /^\/scim\/v2\/Groups$/, module: groupsRoute },
  { pattern: /^\/scim\/v2\/Groups\/([^/]+)$/, module: groupRoute },
  { pattern: /^\/scim\/v2\/ServiceProviderConfig$/, module: spcRoute },
  { pattern: /^\/scim\/v2\/Schemas$/, module: schemasRoute },
  { pattern: /^\/scim\/v2\/Schemas\/([^/]+)$/, module: schemaRoute },
  { pattern: /^\/scim\/v2\/ResourceTypes$/, module: typesRoute },
  { pattern: /^\/scim\/v2\/ResourceTypes\/([^/]+)$/, module: typeRoute },
];

/** A SCIM request through the matching route handler, as the app router would dispatch it. */
async function scim(method: string, path: string, options: Omit<Options, 'method'> = {}) {
  const pathname = path.split('?')[0];
  for (const route of SCIM_ROUTES) {
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    const fn = route.module[method];
    if (!fn) throw new Error(`${method} ${pathname} has no handler`);
    return call(fn, path, { ...options, method }, match[1] ? { id: decodeURIComponent(match[1]) } : {});
  }
  throw new Error(`No SCIM route for ${pathname}`);
}

function sessionToken(headers: Headers): string {
  const line = headers.getSetCookie().find((c) => c.startsWith('landflow_session='))!;
  return decodeURIComponent(line.split(';')[0].slice('landflow_session='.length));
}

const OWNER = { name: 'Olive Owner', email: 'olive@example.com', password: 'owner-password-1' };
let ownerSession = '';
let ownerId = '';
let token = '';

async function signIn(email: string, password: string) {
  return call(loginRoute.POST, '/api/auth/login', { body: { email, password } });
}

/** Deep partial match: objects match on the keys `expected` names, arrays element by element (same length), "{{*}}" anything present. */
function expectMatch(actual: unknown, expected: unknown, at: string) {
  if (expected === '{{*}}') {
    expect(actual, at).toBeDefined();
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${at} is an array`).toBe(true);
    expect((actual as unknown[]).length, `${at}.length`).toBe(expected.length);
    expected.forEach((item, index) => expectMatch((actual as unknown[])[index], item, `${at}[${index}]`));
    return;
  }
  if (expected && typeof expected === 'object') {
    expect(actual && typeof actual === 'object', `${at} is an object`).toBeTruthy();
    for (const [key, value] of Object.entries(expected)) expectMatch((actual as Record<string, unknown>)[key], value, `${at}.${key}`);
    return;
  }
  expect(actual, at).toEqual(expected);
}

/** Replace {{name}} with saved values everywhere in a JSON value. */
function fill<T>(value: T, saved: Record<string, string>): T {
  return JSON.parse(JSON.stringify(value).replace(/\{\{(\w+)\}\}/g, (whole, name: string) => saved[name] ?? whole)) as T;
}

/** The team projects a user is a member of, by name. */
function teamMemberships(userId: string): Record<string, string> {
  return Object.fromEntries(
    projects
      .membershipsOf(userId)
      .map((m) => ({ project: projects.getProject(m.projectId), role: m.role }))
      .filter((m) => m.project?.type === 'team')
      .map((m) => [m.project!.name, m.role]),
  );
}

interface Step {
  name: string;
  request: { method: string; path: string; body?: unknown; headers?: Record<string, string> };
  response: { status: number; body?: unknown; headers?: Record<string, string> };
  save?: Record<string, string>;
  absent?: string[];
  state?: { user: string; deleted?: boolean; role?: string; active?: boolean; provisionedBy?: string; hasPassword?: boolean; email?: string; name?: string; projects?: Record<string, string> };
}

interface Recording {
  provider: string;
  env?: Record<string, string>;
  steps: Step[];
}

async function replay(file: string) {
  const recording = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/scim', file), 'utf8')) as Recording;
  const saved: Record<string, string> = {};
  const before = { ...process.env };
  Object.assign(process.env, recording.env ?? {});
  try {
    for (const raw of recording.steps) {
      const step = fill(raw, saved);
      const result = await scim(step.request.method, step.request.path, { bearer: token, ...(step.request.body !== undefined && { body: step.request.body }), headers: step.request.headers });
      const label = `${recording.provider}: ${step.name}`;
      expect(result.status, `${label} → ${JSON.stringify(result.body)}`).toBe(step.response.status);
      if (step.response.status !== 204) expect(result.headers.get('content-type'), label).toMatch(/^application\/scim\+json/);
      for (const [name, value] of Object.entries(step.response.headers ?? {})) expect(result.headers.get(name), `${label} header ${name}`).toMatch(new RegExp(`^${value.replace(/[+]/g, '\\+')}`));
      if (step.response.body) expectMatch(result.body, fill(step.response.body, saved), label);
      for (const key of step.absent ?? []) expect(result.body, `${label}: no ${key}`).not.toHaveProperty(key);
      for (const [name, field] of Object.entries(raw.save ?? {})) saved[name] = String(result.body[field]);
      if (raw.state) {
        const state = fill(raw.state, saved);
        const user = auth.getUser(state.user);
        if (state.deleted) {
          expect(user, `${label}: user deleted`).toBeUndefined();
          continue;
        }
        expect(user, `${label}: user exists`).toBeDefined();
        if (state.role) expect(user!.role, `${label}: role`).toBe(state.role);
        if (state.active !== undefined) expect(!user!.disabledAt, `${label}: active`).toBe(state.active);
        if (state.provisionedBy) expect(user!.provisionedBy, `${label}: provisionedBy`).toBe(state.provisionedBy);
        if (state.hasPassword !== undefined) expect(Boolean(user!.passwordHash), `${label}: password`).toBe(state.hasPassword);
        if (state.email) expect(user!.email, `${label}: email`).toBe(state.email);
        if (state.name) expect(user!.name, `${label}: name`).toBe(state.name);
        if (state.projects) expect(teamMemberships(user!.id), `${label}: projects`).toEqual(state.projects);
      }
    }
  } finally {
    for (const key of Object.keys(recording.env ?? {})) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
}

/** A user provisioned through SCIM. */
async function provision(userName: string, extra: Record<string, unknown> = {}) {
  const result = await scim('POST', '/scim/v2/Users', { bearer: token, body: { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName, active: true, ...extra } });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body.id as string;
}

async function group(displayName: string, members: string[] = []) {
  const result = await scim('POST', '/scim/v2/Groups', { bearer: token, body: { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName, members: members.map((value) => ({ value })) } });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body.id as string;
}

const patchOp = (...operations: unknown[]) => ({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: operations });

// ---- setup -------------------------------------------------------------------------------------------------

describe('SCIM tokens', () => {
  it('sets up the owner and creates a SCIM token (owners and admins, scim scope alone)', async () => {
    const created = await call(setupRoute.POST, '/api/auth/setup', { body: OWNER });
    expect(created.status).toBe(201);
    ownerSession = sessionToken(created.headers);
    ownerId = created.body.user.id;

    expect((await call(apiKeysRoute.POST, '/api/api-keys', { session: ownerSession, body: { label: 'Mixed', scopes: ['scim', 'workflows:read'] } })).status).toBe(400);
    const key = await call(apiKeysRoute.POST, '/api/api-keys', { session: ownerSession, body: { label: 'Okta provisioning', scopes: ['scim'] } });
    expect(key.status, JSON.stringify(key.body)).toBe(201);
    token = key.body.token;
    expect(key.body.key.scopes).toEqual(['scim']);

    const security = await call(securityRoute.GET, '/api/settings/security', { session: ownerSession });
    expect(security.status).toBe(200);
    expect(security.body.scim).toMatchObject({ baseUrl: 'http://localhost:3000/scim/v2', groups: 0, provisionedUsers: 0 });
    expect(security.body.scim.tokens).toEqual([expect.objectContaining({ label: 'Okta provisioning', userName: 'Olive Owner', scopes: ['scim'] })]);
  });

  it('refuses requests without a valid SCIM token', async () => {
    const none = await scim('GET', '/scim/v2/Users');
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toMatch(/^Bearer/);
    expect(none.body).toMatchObject({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '401' });
    expect((await scim('GET', '/scim/v2/Users', { bearer: 'lf_not-a-real-key' })).status).toBe(401);
    expect((await scim('GET', '/scim/v2/Users', { bearer: 'some-okta-secret' })).status).toBe(401);

    // Other scopes, the admin scope included, aren't SCIM tokens.
    const owner = auth.getUser(ownerId)!;
    const read = createApiKey(owner, { label: 'read', scopes: ['workflows:read'] }).token;
    const admin = createApiKey(owner, { label: 'admin', scopes: ['admin'] }).token;
    expect((await scim('GET', '/scim/v2/Users', { bearer: read })).status).toBe(403);
    const refused = await scim('GET', '/scim/v2/Users', { bearer: admin });
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toMatch(/scim/);

    // And a SCIM token can do nothing else.
    expect((await call(workflowsRoute.GET, '/api/workflows', { bearer: token })).status).toBe(403);
  });

  it('refuses SCIM tokens of members (who can’t create them either)', async () => {
    const member = await auth.createUser({ email: 'mo@example.com', name: 'Mo Member', role: 'member', password: 'mo-password-1' });
    const login = await signIn('mo@example.com', 'mo-password-1');
    expect(login.status).toBe(200);
    const session = sessionToken(login.headers);
    const denied = await call(apiKeysRoute.POST, '/api/api-keys', { session, body: { label: 'mine', scopes: ['scim'] } });
    expect(denied.status).toBe(403);
    const forged = createApiKey(member, { label: 'scim', scopes: ['scim'] }).token;
    const result = await scim('GET', '/scim/v2/Users', { bearer: forged });
    expect(result.status).toBe(403);
    expect(result.body.detail).toMatch(/owner or admin/);
  });

  it('answers the discovery endpoints without a token', async () => {
    const spc = await scim('GET', '/scim/v2/ServiceProviderConfig');
    expect(spc.status).toBe(200);
    expect(spc.headers.get('content-type')).toMatch(/^application\/scim\+json/);
    expect(spc.body).toMatchObject({ patch: { supported: true }, filter: { supported: true }, bulk: { supported: false }, authenticationSchemes: [{ type: 'oauthbearertoken' }] });
    const types = await scim('GET', '/scim/v2/ResourceTypes');
    expect(types.body.Resources.map((t: { id: string }) => t.id)).toEqual(['User', 'Group']);
    expect((await scim('GET', '/scim/v2/ResourceTypes/User')).body).toMatchObject({ endpoint: '/Users', schema: 'urn:ietf:params:scim:schemas:core:2.0:User' });
    expect((await scim('GET', '/scim/v2/ResourceTypes/Nope')).status).toBe(404);
    const schemas = await scim('GET', '/scim/v2/Schemas');
    expect(schemas.body.totalResults).toBe(2);
    const user = await scim('GET', `/scim/v2/Schemas/${encodeURIComponent('urn:ietf:params:scim:schemas:core:2.0:User')}`);
    expect(user.body.attributes.map((a: { name: string }) => a.name)).toContain('userName');
  });
});

// ---- recorded identity provider sequences -----------------------------------------------------------------

describe('recorded provisioning sequences', () => {
  it('replays Okta (users, deactivation, password sync, group push)', async () => {
    await replay('okta.json');
  });

  it('replays Entra ID (enterprise extension, string booleans, value paths, membership checks, deletes)', async () => {
    await replay('entra.json');
  });
});

// ---- filters and pagination -------------------------------------------------------------------------------

describe('filters and pagination', () => {
  it('parses and evaluates SCIM filters', () => {
    const user = { userName: 'Ada@Example.com', active: true, emails: [{ type: 'work', value: 'ada@example.com' }, { type: 'home', value: 'ada@home.test' }], name: { givenName: 'Ada' }, meta: { created: '2026-01-02T00:00:00Z' } };
    const yes = (text: string) => matches(user, parseFilter(text));
    expect(yes('userName eq "ada@example.com"')).toBe(true);
    expect(yes('USERNAME Eq "ADA@EXAMPLE.COM"')).toBe(true);
    expect(yes('urn:ietf:params:scim:schemas:core:2.0:User:userName sw "ada"')).toBe(true);
    expect(yes('emails[type eq "work"].value eq "ada@example.com"')).toBe(true);
    expect(yes('emails[type eq "work"].value eq "ada@home.test"')).toBe(false);
    expect(yes('emails[type eq "home" and value co "home"]')).toBe(true);
    expect(yes('emails.value ew ".test"')).toBe(true);
    expect(yes('active eq true and name.givenName pr')).toBe(true);
    expect(yes('active eq false or userName co "example"')).toBe(true);
    expect(yes('not (active eq true)')).toBe(false);
    expect(yes('(active eq false) or (userName ne "x" and meta.created gt "2026-01-01")')).toBe(true);
    expect(yes('name.familyName pr')).toBe(false);
    expect(() => parseFilter('userName eq')).toThrow();
    expect(() => parseFilter('userName is "x"')).toThrow();
    expect(() => parseFilter('userName eq "unterminated')).toThrow();
  });

  it('pages with startIndex and count, and refuses bad filters', async () => {
    for (const n of [1, 2, 3, 4, 5]) await provision(`page${n}@example.com`, { name: { givenName: 'Page', familyName: String(n) } });
    const all = await scim('GET', '/scim/v2/Users', { bearer: token });
    const total = all.body.totalResults as number;
    expect(total).toBeGreaterThanOrEqual(7);
    expect(all.body.Resources).toHaveLength(total);

    const page = await scim('GET', '/scim/v2/Users?filter=userName%20sw%20%22page%22&startIndex=2&count=2', { bearer: token });
    expect(page.body).toMatchObject({ totalResults: 5, startIndex: 2, itemsPerPage: 2 });
    expect(page.body.Resources.map((r: { userName: string }) => r.userName)).toEqual(['page2@example.com', 'page3@example.com']);
    const last = await scim('GET', '/scim/v2/Users?filter=userName%20sw%20%22page%22&startIndex=5&count=2', { bearer: token });
    expect(last.body).toMatchObject({ totalResults: 5, startIndex: 5, itemsPerPage: 1 });
    const countOnly = await scim('GET', '/scim/v2/Users?filter=userName%20sw%20%22page%22&count=0', { bearer: token });
    expect(countOnly.body).toMatchObject({ totalResults: 5, itemsPerPage: 0, Resources: [] });
    const beyond = await scim('GET', '/scim/v2/Users?startIndex=1000', { bearer: token });
    expect(beyond.body).toMatchObject({ totalResults: total, itemsPerPage: 0, Resources: [] });

    const attributes = await scim('GET', '/scim/v2/Users?filter=userName%20eq%20%22page1%40example.com%22&attributes=userName', { bearer: token });
    expect(Object.keys(attributes.body.Resources[0]).sort()).toEqual(['id', 'meta', 'schemas', 'userName']);

    const bad = await scim('GET', '/scim/v2/Users?filter=userName%20eq', { bearer: token });
    expect(bad.status).toBe(400);
    expect(bad.body.scimType).toBe('invalidFilter');
  });

  it('validates writes', async () => {
    const notEmail = await scim('POST', '/scim/v2/Users', { bearer: token, body: { userName: 'just-a-name' } });
    expect(notEmail.status).toBe(400);
    expect(notEmail.body.scimType).toBe('invalidValue');
    expect((await scim('POST', '/scim/v2/Users', { bearer: token, body: { name: { givenName: 'X' } } })).status).toBe(400);
    const id = await provision('valid@example.com', { externalId: 'ext-valid' });
    expect((await scim('POST', '/scim/v2/Users', { bearer: token, body: { userName: 'other@example.com', externalId: 'ext-valid' } })).body.scimType).toBe('uniqueness');
    expect((await scim('PATCH', `/scim/v2/Users/${id}`, { bearer: token, body: patchOp({ op: 'frobnicate', path: 'active', value: false }) })).status).toBe(400);
    expect((await scim('PATCH', `/scim/v2/Users/${id}`, { bearer: token, body: patchOp({ op: 'remove' }) })).body.scimType).toBe('noTarget');
    expect((await scim('PATCH', `/scim/v2/Users/${id}`, { bearer: token, body: patchOp({ op: 'replace', path: 'active', value: 'maybe' }) })).status).toBe(400);
    expect((await scim('PATCH', `/scim/v2/Users/${id}`, { bearer: token, body: { Operations: [] } })).status).toBe(400);
    expect((await scim('PATCH', `/scim/v2/Users/usr_missing`, { bearer: token, body: patchOp({ op: 'replace', path: 'active', value: false }) })).status).toBe(404);
    const conflict = await scim('PATCH', `/scim/v2/Users/${id}`, { bearer: token, body: patchOp({ op: 'replace', path: 'userName', value: 'page1@example.com' }) });
    expect(conflict.status).toBe(409);
    expect(conflict.body.scimType).toBe('uniqueness');
    // Dotted keys in a path-less value (Entra sends these too).
    const dotted = await scim('PATCH', `/scim/v2/Users/${id}`, { bearer: token, body: patchOp({ op: 'replace', value: { 'name.givenName': 'Val', 'name.familyName': 'Id', externalId: 'ext-new' } }) });
    expect(dotted.body).toMatchObject({ displayName: 'Val Id', externalId: 'ext-new' });
    expect((await scim('POST', '/scim/v2/Groups', { bearer: token, body: { displayName: ' ' } })).status).toBe(400);
  });
});

// ---- deactivation ------------------------------------------------------------------------------------------

describe('deactivation', () => {
  it('signs the user out and blocks password sign-in and API keys until reactivated', async () => {
    const user = await auth.createUser({ email: 'dee@example.com', name: 'Dee Active', role: 'member', password: 'dee-password-1' });
    const login = await signIn('dee@example.com', 'dee-password-1');
    expect(login.status).toBe(200);
    const session = sessionToken(login.headers);
    const key = createApiKey(user, { label: 'cli', scopes: ['workflows:read'] }).token;
    expect((await call(meRoute.GET, '/api/auth/me', { session })).status).toBe(200);
    expect((await call(workflowsRoute.GET, '/api/workflows', { bearer: key })).status).toBe(200);

    // The identity provider links the existing account, then deactivates it.
    const found = await scim('GET', '/scim/v2/Users?filter=userName%20eq%20%22dee%40example.com%22', { bearer: token });
    expect(found.body.totalResults).toBe(1);
    expect(found.body.Resources[0].id).toBe(user.id);
    const off = await scim('PATCH', `/scim/v2/Users/${user.id}`, { bearer: token, body: patchOp({ op: 'replace', value: { active: false } }) });
    expect(off.body.active).toBe(false);

    expect((await call(meRoute.GET, '/api/auth/me', { session })).status).toBe(401);
    const again = await signIn('dee@example.com', 'dee-password-1');
    expect(again.status).toBe(403);
    expect(again.body.error).toMatch(/deactivated/);
    expect((await call(workflowsRoute.GET, '/api/workflows', { bearer: key })).status).toBe(401);
    expect(() => auth.createSession(auth.getUser(user.id)!, 'oidc')).toThrow(/deactivated/);

    await scim('PATCH', `/scim/v2/Users/${user.id}`, { bearer: token, body: patchOp({ op: 'Replace', path: 'active', value: 'True' }) });
    expect((await signIn('dee@example.com', 'dee-password-1')).status).toBe(200);
    expect((await call(workflowsRoute.GET, '/api/workflows', { bearer: key })).status).toBe(200);
    // The old session stays gone.
    expect((await call(meRoute.GET, '/api/auth/me', { session })).status).toBe(401);
  });

  it('never deactivates or removes the owner, and refuses SCIM tokens of a deactivated admin', async () => {
    const owner = await scim('PATCH', `/scim/v2/Users/${ownerId}`, { bearer: token, body: patchOp({ op: 'replace', value: { active: false } }) });
    expect(owner.status).toBe(403);
    expect(auth.getUser(ownerId)!.disabledAt).toBeUndefined();
    expect((await scim('DELETE', `/scim/v2/Users/${ownerId}`, { bearer: token })).status).toBe(403);

    const admin = await auth.createUser({ email: 'ada.admin@example.com', name: 'Ada Admin', role: 'admin' });
    const adminToken = createApiKey(admin, { label: 'entra', scopes: ['scim'] }).token;
    expect((await scim('GET', '/scim/v2/Groups', { bearer: adminToken })).status).toBe(200);
    await scim('PATCH', `/scim/v2/Users/${admin.id}`, { bearer: token, body: patchOp({ op: 'replace', path: 'active', value: false }) });
    expect((await scim('GET', '/scim/v2/Groups', { bearer: adminToken })).status).toBe(401);
  });
});

// ---- groups → projects and roles --------------------------------------------------------------------------

describe('group mappings', () => {
  it('parses LANDFLOW_SCIM_GROUP_MAP', () => {
    const map = scimGroupMap('Landflow Admins=role:admin, Data Team=project:Data:viewer,Ops=project:prj_abc,Bad=nothing,Members=role:member');
    expect(map).toEqual({
      'Landflow Admins': { role: 'admin' },
      'Data Team': { project: { project: 'Data', role: 'viewer' } },
      Ops: { project: { project: 'prj_abc', role: 'editor' } },
      Members: { role: 'member' },
    });
    expect(describeGroupMap(map)).toEqual({ 'Landflow Admins': 'role:admin', 'Data Team': 'project:Data:viewer', Ops: 'project:prj_abc:editor', Members: 'role:member' });
  });

  it('maps groups to project memberships and the admin role, and leaves the owner and manual memberships alone', async () => {
    process.env.LANDFLOW_SCIM_GROUP_MAP = 'Landflow Admins=role:admin,Analysts=project:Analytics:viewer';
    try {
      const marketing = projects.createTeamProject({ name: 'Marketing' });
      const sales = projects.createTeamProject({ name: 'Sales' });
      const ann = await provision('ann@example.com');
      projects.setMember(sales.id, ann, 'viewer');

      const analysts = await group('Analysts', [ann]);
      expect(teamMemberships(ann)).toEqual({ Sales: 'viewer', Analytics: 'viewer' });
      expect(projects.findProject('Analytics')?.type).toBe('team');
      // A group named like a team project, without a mapping: editors there.
      const team = await group('marketing', [ann]);
      expect(teamMemberships(ann)).toEqual({ Sales: 'viewer', Analytics: 'viewer', Marketing: 'editor' });
      expect(projects.memberRole(marketing.id, ann)).toBe('editor');

      const admins = await group('Landflow Admins', [ann, ownerId]);
      expect(auth.getUser(ann)!.role).toBe('admin');
      expect(auth.getUser(ownerId)!.role).toBe('owner');
      // The security view counts them.
      const security = await call(securityRoute.GET, '/api/settings/security', { session: ownerSession });
      expect(security.body.scim.groupMap).toEqual({ 'Landflow Admins': 'role:admin', Analysts: 'project:Analytics:viewer' });
      expect(security.body.scim.groups).toBeGreaterThanOrEqual(3);

      // Leaving the admin group demotes; the owner stays the owner.
      await scim('PATCH', `/scim/v2/Groups/${admins}`, { bearer: token, body: patchOp({ op: 'Remove', path: 'members', value: [{ value: ann }, { value: ownerId }] }) });
      expect(auth.getUser(ann)!.role).toBe('member');
      expect(auth.getUser(ownerId)!.role).toBe('owner');

      // Replacing every member, then deleting the groups: the SCIM memberships go, the manual one stays.
      await scim('PATCH', `/scim/v2/Groups/${analysts}`, { bearer: token, body: patchOp({ op: 'replace', path: 'members', value: [] }) });
      expect(teamMemberships(ann)).toEqual({ Sales: 'viewer', Marketing: 'editor' });
      expect((await scim('DELETE', `/scim/v2/Groups/${team}`, { bearer: token })).status).toBe(204);
      expect(teamMemberships(ann)).toEqual({ Sales: 'viewer' });
      expect((await scim('DELETE', `/scim/v2/Groups/${team}`, { bearer: token })).status).toBe(404);

      // Duplicate group names are conflicts; unknown member ids are skipped.
      expect((await scim('POST', '/scim/v2/Groups', { bearer: token, body: { displayName: 'ANALYSTS' } })).status).toBe(409);
      const ghost = await scim('POST', '/scim/v2/Groups', { bearer: token, body: { displayName: 'Ghosts', members: [{ value: 'usr_nobody' }, { value: ann }] } });
      expect(ghost.body.members.map((m: { value: string }) => m.value)).toEqual([ann]);
      expect((await scim('GET', '/scim/v2/Groups?filter=displayName%20eq%20%22ghosts%22&excludedAttributes=members', { bearer: token })).body.Resources[0]).not.toHaveProperty('members');
    } finally {
      delete process.env.LANDFLOW_SCIM_GROUP_MAP;
    }
  });

  it('doesn’t touch instance roles when the map has no role entries', async () => {
    const bea = await auth.createUser({ email: 'bea@example.com', name: 'Bea Admin', role: 'admin', externalId: 'ext-bea' });
    const g = await group('Some Group', [bea.id]);
    await scim('PATCH', `/scim/v2/Groups/${g}`, { bearer: token, body: patchOp({ op: 'remove', path: `members[value eq "${bea.id}"]` }) });
    expect(auth.getUser(bea.id)!.role).toBe('admin');
  });
});

// ---- deleting users ----------------------------------------------------------------------------------------

describe('DELETE /Users', () => {
  it('removes the user and moves what they owned to the owner’s personal project', async () => {
    const cy = await provision('cy@example.com');
    const personal = projects.ensurePersonalProject(cy)!;
    projects.setHomeProject('workflow', 'wf_scim_owned', personal);
    projects.setHomeProject('credential', 'cred_scim_owned', personal);
    const g = await group('Cy Group', [cy]);
    const key = createApiKey(auth.getUser(cy)!, { label: 'x', scopes: ['workflows:read'] }).token;

    expect((await scim('DELETE', `/scim/v2/Users/${cy}`, { bearer: token })).status).toBe(204);
    expect(auth.getUser(cy)).toBeUndefined();
    expect(projects.homeProjectId('workflow', 'wf_scim_owned')).toBe(personalProjectId(ownerId));
    expect(projects.homeProjectId('credential', 'cred_scim_owned')).toBe(personalProjectId(ownerId));
    expect(projects.getProject(personal)).toBeUndefined();
    expect((await scim('GET', `/scim/v2/Groups/${g}`, { bearer: token })).body.members).toEqual([]);
    expect((await call(workflowsRoute.GET, '/api/workflows', { bearer: key })).status).toBe(401);
    expect((await scim('DELETE', `/scim/v2/Users/${cy}`, { bearer: token })).status).toBe(404);
  });
});
