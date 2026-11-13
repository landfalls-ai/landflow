/**
 * Domain errors are HttpErrors: throwing one inside `handler()` answers its status, message and extra fields without
 * the route catching it (the 100-odd per-route catch blocks that did so by hand are gone). One class per domain, plus
 * the ones that carry extra fields (the response keeps them), and a check that no class with a status is left outside
 * the HttpError tree.
 */
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-error-mapping-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { HttpError } = await import('@/lib/server/errors');
const { handler } = await import('@/lib/server/http');
const { VariableError } = await import('@/lib/server/variable-store');
const { PublishError } = await import('@/lib/server/publish');
const { FolderError, FolderNotEmptyError } = await import('@/lib/server/folders');
const { ProjectError } = await import('@/lib/server/projects/store');
const { DataTableError } = await import('@/lib/server/datatables/storage');
const { CredentialError } = await import('@/lib/server/credentials/vault');
const { SecretsError } = await import('@/lib/server/secrets/service');
const { SourceControlError } = await import('@/lib/server/sync/git');
const { ProposalError } = await import('@/lib/server/brain/proposals');
const { McpGrantError } = await import('@/lib/server/mcp/grants');
const { EnvironmentError } = await import('@/lib/server/environments/settings');
const { TemplateError } = await import('@/lib/server/templates');
const { CompositeError } = await import('@/lib/server/composites');
const { BinaryTooLargeError } = await import('@/lib/server/binary/store');
const { AgentTeamError } = await import('@/lib/server/agent-teams/store');
const { DuplicateRunError } = await import('@/lib/server/idempotency');
const { RunSkippedError } = await import('@/lib/server/concurrency');
const { SamlKeyError } = await import('@/lib/server/auth/saml-keys');
const { TranscribeError } = await import('@/lib/server/assistant/transcribe');

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const answer = async (caught: unknown) => {
  const response = await handler(async () => {
    throw caught;
  })(new Request('http://localhost/api/error-mapping-test'));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

describe('an HttpError from another copy of the module', () => {
  // The production server bundles a module once per layer, and a singleton() store made in one layer throws that
  // layer's classes into another layer's handler(): a FolderNotEmptyError answered 500 on a production host.
  it('answers its status and code, and instanceof matches by class name only', async () => {
    vi.resetModules();
    const copy = await import('@/lib/server/folders');
    const other = new copy.FolderNotEmptyError(0, 1);
    expect(copy.FolderNotEmptyError).not.toBe(FolderNotEmptyError);
    expect(other).toBeInstanceOf(HttpError);
    expect(other).toBeInstanceOf(FolderNotEmptyError);
    expect(other).not.toBeInstanceOf(FolderError);
    expect(new Error('plain')).not.toBeInstanceOf(HttpError);
    expect({ status: 409 }).not.toBeInstanceOf(HttpError);
    const { status, body } = await answer(other);
    expect(status).toBe(409);
    expect(body).toMatchObject({ error: "The folder isn't empty: it holds 1 workflow", code: 'folder_not_empty_error', folders: 0, workflows: 1 });
  });
});

describe('domain errors answer through handler()', () => {
  const cases: Array<[string, () => Error, number, string]> = [
    ['variables', () => new VariableError('Enter a key'), 400, 'variable_error'],
    ['publishing', () => new PublishError('Nothing to publish', 409), 409, 'publish_error'],
    ['folders', () => new FolderError('A folder needs a name'), 400, 'folder_error'],
    ['projects', () => new ProjectError('Project not found', 404), 404, 'project_error'],
    ['data tables', () => new DataTableError('No such column'), 400, 'data_table_error'],
    ['credentials', () => new CredentialError('Credential not found', 404), 404, 'credential_error'],
    ['secrets', () => new SecretsError('Unknown provider'), 400, 'secrets_error'],
    ['source control', () => new SourceControlError('Not configured', 409), 409, 'source_control_error'],
    ['brain', () => new ProposalError('Already decided', 409), 409, 'proposal_error'],
    ['mcp', () => new McpGrantError('No such grant', 404), 404, 'mcp_grant_error'],
    ['environments', () => new EnvironmentError('Not protected'), 400, 'environment_error'],
    ['auth', () => new SamlKeyError('The key comes from the environment'), 400, 'saml_key_error'],
  ];
  it.each(cases)('%s', async (_domain, make, status, code) => {
    const error = make();
    expect(error).toBeInstanceOf(HttpError);
    const { status: got, body } = await answer(error);
    expect(got).toBe(status);
    expect(body).toMatchObject({ error: error.message, code });
  });

  it('keeps the message of a 5xx domain error (the routes always showed it)', async () => {
    const { status, body } = await answer(new TranscribeError('The speech service is down'));
    expect(status).toBe(502);
    expect(body.error).toBe('The speech service is down');
  });

  it('keeps the extra fields the routes used to add', async () => {
    expect((await answer(new FolderNotEmptyError(2, 1))).body).toMatchObject({ folders: 2, workflows: 1 });
    expect((await answer(new TemplateError('Not usable', 409, { problems: ['x'] }))).body).toMatchObject({ problems: ['x'] });
    expect(await answer(new CompositeError('Invalid composite type', 400, ['a: b']))).toMatchObject({ status: 400, body: { details: ['a: b'] } });
    expect(await answer(new CompositeError('Nope'))).toMatchObject({ status: 400, body: { error: 'Nope' } });
    expect((await answer(new AgentTeamError('Fix these before publishing', ['no lead']))).body).toMatchObject({ issues: ['no lead'] });
    expect(await answer(new BinaryTooLargeError(10))).toMatchObject({ status: 413 });
    expect(await answer(new DuplicateRunError('exec-1', 'k'))).toMatchObject({ status: 409, body: { executionId: 'exec-1' } });
    expect(await answer(new RunSkippedError('wf-1', 'singleton'))).toMatchObject({ status: 429, body: { workflowId: 'wf-1', reason: 'singleton' } });
    expect((await answer(new FolderNotEmptyError(0, 3))).status).toBe(409);
  });

  it('answers a class without a status as a generic 500', async () => {
    class Internal extends Error {}
    const { status, body } = await answer(new Internal('SELECT * FROM secrets failed'));
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('SELECT');
  });
});

describe('the HttpError tree', () => {
  const root = join(__dirname, '..', 'src', 'lib', 'server');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : name.endsWith('.ts') ? [path] : [];
    });

  it('leaves no domain error that carries a status outside it', () => {
    // `class X extends Error { … status … }` within a few lines: a status that only a route catch could map.
    const stray = files(root).flatMap((path) => {
      const lines = readFileSync(path, 'utf8').split('\n');
      return lines.flatMap((line, i) => (/class \w+ extends Error\b/.test(line) && lines.slice(i, i + 8).some((l) => /\bstatus\b/.test(l)) ? [`${path.slice(root.length + 1)}:${i + 1} ${line.trim()}`] : []));
    });
    // Upstream status codes (a Kubernetes or MCP answer) and runner.ts's classes (converted with its split) are not mapped.
    expect(stray.filter((entry) => !/errors\.ts|runner\.ts|db\/|McpClientError|GatewayAdapterError|SecretProviderError|OAuth2Error|SystemOneApiError|journal\/store/.test(entry))).toEqual([]);
  });

  it('gives every HttpError subclass a literal errorName (the production bundle minifies class names)', () => {
    // Without one, `code` and `name` come from `new.target.name`, which `next build` turns into a letter such as "v".
    const sources = [...files(root), ...files(join(__dirname, '..', 'src', 'app'))].map((path) => ({ path, text: readFileSync(path, 'utf8') }));
    const declarations = sources.flatMap(({ path, text }) =>
      [...text.matchAll(/class (\w+) extends (\w+)\s*\{\n?([^\n]*)/g)].map(([, name, base, firstLine]) => ({ path, name, base, firstLine })),
    );
    const tree = new Set(['HttpError']);
    for (let grew = true; grew; ) {
      grew = false;
      for (const { name, base } of declarations) {
        if (tree.has(base) && !tree.has(name)) {
          tree.add(name);
          grew = true;
        }
      }
    }
    const subclasses = declarations.filter(({ name, base }) => name !== 'HttpError' && tree.has(base));
    expect(subclasses.length).toBeGreaterThan(50);
    const unnamed = subclasses.filter(({ name, firstLine }) => firstLine.trim() !== `static readonly errorName: string = '${name}';`);
    expect(unnamed.map(({ path, name }) => `${path}: ${name}`)).toEqual([]);
  });

  it('takes name and code from errorName, not the (minifiable) class name', () => {
    class v extends HttpError {
      static readonly errorName: string = 'CheckError';
    }
    const error = new v('No such check in that span', 404);
    expect(error.name).toBe('CheckError');
    expect(error.code).toBe('check_error');
    expect(new RunSkippedError('wf-1', 'singleton')).toMatchObject({ name: 'RunSkippedError', code: 'run_skipped_error' });
  });
});
