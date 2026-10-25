/**
 * A real Landflow host for the CLI tests: the web app's route handlers (apps/web/src/app/api/**\/route.ts, the real
 * auth guard, store and runner) behind a tiny node:http server on a free port, with its data in a temp directory.
 * Paths are routed the way Next does — static segments before `[param]` — and a path no route has answers an HTML
 * 404, as Next does. Guarded requests without credentials run as the test owner (`enableTestAuth`), as in the web
 * tests; a request with an API key goes through the real key check.
 */
import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Io } from '../src/command';

export const WEB_SRC = fileURLToPath(new URL('../../../apps/web/src', import.meta.url));

/** Import a web module by its path under apps/web/src (`lib/server/store`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const web = <T = any>(path: string): Promise<T> => {
  const file = existsSync(join(WEB_SRC, `${path}.ts`)) ? join(WEB_SRC, `${path}.ts`) : join(WEB_SRC, path, 'index.ts');
  return import(/* @vite-ignore */ pathToFileURL(file).href) as Promise<T>;
};

interface Route {
  segments: string[];
  file: string;
}

function scanRoutes(dir: string, out: Route[] = []): Route[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) scanRoutes(full, out);
    else if (name === 'route.ts') out.push({ segments: relative(join(WEB_SRC, 'app'), dir).split(sep), file: full });
  }
  return out;
}

const dynamic = (segment: string) => segment.startsWith('[') && segment.endsWith(']');

function match(routes: Route[], parts: string[]): { route: Route; params: Record<string, string | string[]> } | undefined {
  const found: Array<{ route: Route; params: Record<string, string | string[]>; score: string }> = [];
  for (const route of routes) {
    const params: Record<string, string | string[]> = {};
    let ok = true;
    let score = '';
    for (let i = 0; i < route.segments.length; i++) {
      const segment = route.segments[i];
      if (segment.startsWith('[...')) {
        params[segment.slice(4, -1)] = parts.slice(i).map(decodeURIComponent);
        ok = parts.length > i;
        score += '2';
        break;
      }
      if (i >= parts.length) {
        ok = false;
        break;
      }
      if (dynamic(segment)) {
        params[segment.slice(1, -1)] = decodeURIComponent(parts[i]);
        score += '1';
      } else if (segment === parts[i]) score += '0';
      else {
        ok = false;
        break;
      }
      if (i === route.segments.length - 1 && parts.length !== route.segments.length) ok = false;
    }
    if (ok) found.push({ route, params, score });
  }
  return found.sort((a, b) => (a.score < b.score ? -1 : 1))[0];
}

export interface Host {
  url: string;
  dataDir: string;
  close(): Promise<void>;
}

/** Start the host: a fresh data directory, the bootstrap run, and its seeded workflows removed. */
export async function startHost(): Promise<Host> {
  const dataDir = mkdtempSync(join(tmpdir(), 'landflow-cli-host-'));
  Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
  (await web('lib/server/auth/test-bypass')).enableTestAuth();
  await (await web('lib/server/bootstrap')).ensureBootstrapped();
  const { store } = await web('lib/server/store');
  for (const w of store.listWorkflows()) store.deleteWorkflow(w.id);

  const routes = scanRoutes(join(WEB_SRC, 'app', 'api'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const modules = new Map<string, Promise<any>>();
  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://cli.test');
      const found = match(routes, url.pathname.split('/').filter(Boolean));
      if (!found) {
        res.writeHead(404, { 'content-type': 'text/html' }).end('<!DOCTYPE html><title>404: This page could not be found.</title>');
        return;
      }
      if (!modules.has(found.route.file)) modules.set(found.route.file, import(/* @vite-ignore */ pathToFileURL(found.route.file).href));
      const handler = (await modules.get(found.route.file))[req.method ?? 'GET'];
      if (typeof handler !== 'function') {
        res.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
      const hasBody = !['GET', 'HEAD'].includes(req.method ?? 'GET') && chunks.length > 0;
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, ...(hasBody && { body: Buffer.concat(chunks) }) });
      const response: Response = await handler(request, { params: Promise.resolve(found.params) });
      const out: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        out[key] = value;
      });
      res.writeHead(response.status, out).end(Buffer.from(await response.arrayBuffer()));
    } catch (caught) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (caught as Error).message }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    dataDir,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

export interface CliOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  stdin?: string;
  fetch?: typeof fetch;
}

/** A CLI bound to a host: `cli(['workflows', 'list', '--json'])` runs it in-process. */
export function cliFor(host: { url: string }, defaults: CliOptions = {}) {
  const home = mkdtempSync(join(tmpdir(), 'landflow-cli-home-'));
  return async (argv: string[], options: CliOptions = {}): Promise<CliRun> => {
    const { run } = await import('../src/index');
    let stdout = '';
    let stderr = '';
    const io: Io = {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      readStdin: async () => options.stdin ?? defaults.stdin ?? '',
      env: { LANDFLOW_URL: host.url, LANDFLOW_CONFIG: join(home, 'config.json'), ...defaults.env, ...options.env },
      cwd: options.cwd ?? defaults.cwd ?? home,
      home,
      interactive: false,
      prompt: async () => {
        throw new Error('no prompts in tests');
      },
      fetch: options.fetch ?? defaults.fetch ?? globalThis.fetch,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 25))),
    };
    const code = await run(argv, io);
    let json: unknown;
    if (argv.includes('--json')) {
      try {
        json = JSON.parse(stdout);
      } catch {
        json = undefined;
      }
    }
    return { code, stdout, stderr, json };
  };
}
