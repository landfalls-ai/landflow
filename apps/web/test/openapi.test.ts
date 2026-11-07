/**
 * The OpenAPI document (lib/server/openapi.ts, GET /api/openapi.json): well-formed 3.1, every operation named,
 * tagged and scoped like the route guard (trigger URLs: public, like lib/shared/auth-paths.ts says), every $ref
 * resolving, and every documented path and method an actual route under app/, so the docs can't name endpoints that
 * don't exist.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-openapi-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { openApiDocument } = await import('@/lib/server/openapi');
const { routePolicy } = await import('@/lib/server/auth/policy');
const { isPublicPath } = await import('@/lib/shared/auth-paths');

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

type Json = Record<string, unknown>;
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const appDir = fileURLToPath(new URL('../src/app', import.meta.url));

const doc = openApiDocument('http://landflow.test') as Json & { paths: Record<string, Record<string, Json>>; components: Json };
const operations = Object.entries(doc.paths).flatMap(([path, item]) => METHODS.filter((m) => item[m]).map((method) => ({ path, method, op: item[method] })));

/** The trigger URLs' catch-all routes: `{path}` there is `[...path]` (it may hold slashes). */
const CATCH_ALL = /^\/(api\/webhook|api\/webhook-test|form|form-test|mcp|mcp-test)\/\{path\}$/;

/** Every `$ref` value anywhere under `value`. */
function refs(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => refs(v, out));
  else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (key === '$ref' && typeof v === 'string') out.push(v);
      else refs(v, out);
    }
  }
  return out;
}

/** `#/components/schemas/Workflow` → the value it points at in `doc`, or undefined. */
function resolve(pointer: string): unknown {
  if (!pointer.startsWith('#/')) return undefined;
  return pointer
    .slice(2)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Json)[part] : undefined), doc);
}

describe('OpenAPI document', () => {
  it('is OpenAPI 3.1 for the Landflow API', () => {
    expect(String(doc.openapi)).toMatch(/^3\.1/);
    expect((doc.info as Json).title).toBe('Landflow API');
    expect(doc.servers).toEqual([{ url: 'http://landflow.test' }]);
    expect((openApiDocument() as Json).servers).toEqual([{ url: '/' }]);
    expect(operations.length).toBeGreaterThan(40);
  });

  it('names, tags and scopes every operation like the route guard', () => {
    const tags = new Set(((doc.tags as Json[]) ?? []).map((t) => t.name));
    const ids = operations.map(({ op }) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { path, method, op } of operations) {
      const where = `${method.toUpperCase()} ${path}`;
      expect(op.operationId, where).toMatch(/^[a-zA-Z]+$/);
      expect(op.summary, where).toBeTruthy();
      expect(Object.keys(op.responses as Json).length, where).toBeGreaterThan(0);
      expect(op.tags, where).toHaveLength(1);
      expect(tags.has((op.tags as string[])[0]), where).toBe(true);
      const sample = path.replace(/\{[^}]+\}/g, 'x');
      // Public operations are exactly the ones the auth gate lets through without a session or key.
      expect(Boolean(op['x-landflow-public']), where).toBe(isPublicPath(sample));
      if (op['x-landflow-public']) {
        expect(op.security, where).toEqual([]);
        expect(op['x-landflow-scope'], where).toBeUndefined();
        continue;
      }
      const policy = routePolicy(method.toUpperCase(), sample);
      expect(op['x-landflow-scope'], where).toBe(policy.scope);
      expect(op.description, where).toEqual(expect.stringContaining(policy.sessionOnly ? 'API keys are refused' : policy.scope === 'any' ? 'Any API key' : `\`${policy.scope}\``));
    }
  });

  it('documents the settings routes, with json-render the owner’s', () => {
    expect(doc.paths['/api/settings'].get['x-landflow-scope']).toBe('workflows:read');
    expect(doc.paths['/api/settings'].patch['x-landflow-scope']).toBe('admin');
    expect(String(doc.paths['/api/settings'].patch.description)).toContain('owner');
  });

  it('documents running, the API key routes as session-only and variables writes as admin', () => {
    expect(doc.paths['/api/workflows/{id}/run'].post['x-landflow-scope']).toBe('run');
    expect(doc.paths['/api/workflows/{id}/execute'].post['x-landflow-scope']).toBe('run');
    expect(doc.paths['/api/api-keys'].post['x-landflow-session-only']).toBe(true);
    expect(doc.paths['/api/variables'].get['x-landflow-scope']).toBe('workflows:read');
    expect(doc.paths['/api/variables'].post['x-landflow-scope']).toBe('admin');
    expect(doc.paths['/api/variables'].post['x-landflow-role-action']).toBe('variables:manage');
    // Path parameters come from the template.
    expect(doc.paths['/api/workflows/{id}/versions/{versionId}'].get.parameters).toEqual([
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
      expect.objectContaining({ name: 'versionId', in: 'path', required: true }),
    ]);
  });

  it('documents the trigger URLs, their test URLs and listening for a test event', () => {
    const methods = (path: string) => Object.keys(doc.paths[path] ?? {}).sort();
    expect(methods('/api/webhook/{path}')).toEqual(['delete', 'get', 'patch', 'post', 'put']);
    expect(methods('/api/webhook-test/{path}')).toEqual(['delete', 'get', 'patch', 'post', 'put']);
    expect(methods('/form/{path}')).toEqual(['get', 'post']);
    expect(methods('/form-test/{path}')).toEqual(['get', 'post']);
    expect(methods('/mcp/{path}')).toEqual(['post']);
    expect(methods('/mcp-test/{path}')).toEqual(['post']);
    const webhook = doc.paths['/api/webhook/{path}'].post;
    expect(webhook).toMatchObject({ tags: ['Triggers'], security: [], 'x-landflow-public': true });
    // A generic path parameter and a free-form body.
    expect(webhook.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'path', in: 'path', required: true })]));
    expect(Object.keys(((webhook.requestBody as Json).content as Json) ?? {})).toEqual(expect.arrayContaining(['application/json', 'multipart/form-data']));
    expect(webhook.responses).toHaveProperty('403');
    expect(doc.paths['/api/webhook/{path}'].get.requestBody).toBeUndefined();
    expect(doc.paths['/mcp-test/{path}'].post.description).toContain('manual run');
    // The listen route is an ordinary API route (scope run) that streams.
    const listen = doc.paths['/api/workflows/{id}/listen'].post;
    expect(listen['x-landflow-scope']).toBe('run');
    expect(Object.keys((((listen.responses as Json)[200] as Json).content as Json) ?? {})).toEqual(['text/event-stream']);
  });

  it('resolves every $ref inside the document', () => {
    const all = refs(doc);
    expect(all.length).toBeGreaterThan(50);
    for (const pointer of new Set(all)) expect(resolve(pointer), pointer).toBeDefined();
    const schemas = (doc.components as Json).schemas as Json;
    for (const name of ['Workflow', 'WorkflowInput', 'WorkflowSummary', 'ExecutionSummary', 'ExecutionRecord', 'DataTable', 'DataTableRow', 'RowFilter', 'Variable', 'ApiKey', 'Viewer', 'Error']) {
      expect(schemas[name], name).toBeDefined();
    }
    // The workflow body is the route's zod schema.
    expect(schemas.WorkflowInput).toMatchObject({ type: 'object', required: ['name'] });
    expect(Object.keys((schemas.WorkflowInput as Json).properties as Json)).toEqual(expect.arrayContaining(['name', 'nodes', 'connections', 'settings']));
  });

  it('offers a bearer key, the key header and the session cookie', () => {
    const schemes = (doc.components as Json).securitySchemes as Json;
    expect(schemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(schemes.apiKeyHeader).toMatchObject({ type: 'apiKey', in: 'header', name: 'X-Landflow-API-Key' });
    expect(schemes.sessionCookie).toMatchObject({ type: 'apiKey', in: 'cookie', name: 'landflow_session' });
    expect(doc.security).toEqual([{ bearerAuth: [] }, { apiKeyHeader: [] }, { sessionCookie: [] }]);
  });

  it('documents only routes that exist, with their methods', () => {
    for (const { path, method } of operations) {
      const file = join(appDir, CATCH_ALL.test(path) ? path.replace('{path}', '[...path]') : path.replace(/\{([^}]+)\}/g, '[$1]'), 'route.ts');
      expect(existsSync(file), `${path} → ${file}`).toBe(true);
      const source = readFileSync(file, 'utf8');
      expect(source, `${method.toUpperCase()} ${path}`).toMatch(new RegExp(`^export (const|async function|function) ${method.toUpperCase()}\\b`, 'm'));
    }
  });

  it('serves the document at GET /api/openapi.json with this origin', async () => {
    const route = await import('@/app/api/openapi.json/route');
    const response = await route.GET(new Request('http://docs.test/api/openapi.json'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const served = (await response.json()) as Json;
    expect(Object.keys(served.paths as Json)).toEqual(Object.keys(doc.paths));
    expect(served.servers).toEqual([{ url: process.env.LANDFLOW_PUBLIC_URL?.replace(/\/+$/, '') || 'http://docs.test' }]);
  });
});
