/**
 * A scratch Landflow host for the browser tier: its own empty data directory, a free port, the development profile and
 * no owner (the first flow is the setup page). Never `apps/web/.data`, never a port another host holds, never a
 * network beyond loopback. `startScratchHost()` starts `next dev` from `apps/web` and waits for `/api/health`;
 * `prod: true` starts `next start` on an existing build instead (the CSP smoke test, `LANDFLOW_E2E_PROD=1`).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
/** The host's live data directory: a scratch host must never be pointed at it. */
export const LIVE_DATA_DIR = join(WEB_DIR, '.data');

export interface ScratchHostOptions {
  /** `next start` on the existing `.next` build, production profile, CSP enforced. Default: `next dev`. */
  prod?: boolean;
  /** Extra environment for the host (the fakes' URLs, a flag). */
  env?: Record<string, string>;
  /** Use this empty directory as the data directory (refused when it is, or is inside, `apps/web/.data`). Default: a new temp directory. */
  dataDir?: string;
  /** Milliseconds to wait for the host to answer `/api/health` (default 240 000: the first compile is slow). */
  timeoutMs?: number;
}

export interface ScratchHost {
  /** `http://localhost:<port>` (not 127.0.0.1: `next dev` blocks its dev resources for other origins). */
  url: string;
  port: number;
  dataDir: string;
  logFile: string;
  stop(): Promise<void>;
}

/** Throws when `dir` is the live data directory or inside it. */
export function assertScratchDataDir(dir: string): void {
  const rel = relative(LIVE_DATA_DIR, resolve(dir));
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep))) throw new Error(`scratch host: refusing to use ${dir}: it is apps/web/.data (the live data directory)`);
}

/** A free TCP port on loopback (asked of the OS; the caller binds it a moment later). */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePort(port));
    });
  });
}

/** The few variables a host needs from the shell: nothing that could carry a real vendor key or proxy. */
function baseEnv(): Record<string, string> {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'TERM'];
  return Object.fromEntries(keep.flatMap((name) => (process.env[name] ? [[name, process.env[name] as string]] : [])));
}

async function waitForHealth(url: string, child: ChildProcess, logFile: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`scratch host exited with ${child.exitCode} before it was ready; log: ${logFile}\n${tail(logFile)}`);
    try {
      const response = await fetch(`${url}/api/health/live`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > until) throw new Error(`scratch host did not answer ${url}/api/health/live within ${timeoutMs / 1000} s; log: ${logFile}\n${tail(logFile)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function tail(file: string): string {
  try {
    return readFileSync(file, 'utf8').split('\n').slice(-25).join('\n');
  } catch {
    return '';
  }
}

export async function startScratchHost(options: ScratchHostOptions = {}): Promise<ScratchHost> {
  const ownsDir = !options.dataDir;
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'landflow-e2e-'));
  assertScratchDataDir(dataDir);
  mkdirSync(dataDir, { recursive: true });
  const port = await freePort();
  const url = `http://localhost:${port}`;
  const logFile = join(dataDir, '..', `${dataDir.split(sep).pop()}.host.log`);
  const log = createWriteStream(logFile);

  const env: Record<string, string> = {
    ...baseEnv(),
    // Never reach beyond loopback: no proxy, and nothing for a vendor client to find.
    NO_PROXY: '*',
    no_proxy: '*',
    PORT: String(port),
    LANDFLOW_DATA_DIR: dataDir,
    LANDFLOW_PUBLIC_URL: url,
    LANDFLOW_REGISTRY_GRPC_PORT: 'off',
    LANDFLOW_SCAN_ON_START: 'false',
    LANDFLOW_MCP_GATEWAY: 'off',
    LANDFLOW_PLUGINS: '',
    LANDFLOW_LOG_LEVEL: 'warn',
    LANDFLOW_BRAIN_EMBEDDINGS: 'off',
    LANDFLOW_OUTBOUND_ALLOW: '127.0.0.1,localhost',
    // The Content Security Policy is enforced for every page the tier opens (the dev default is report-only).
    LANDFLOW_CSP: 'enforce',
    NEXT_TELEMETRY_DISABLED: '1',
    ...(options.prod && { LANDFLOW_PROFILE: 'production', NODE_ENV: 'production', LANDFLOW_OUTBOUND_BLOCK_PRIVATE: 'false', LANDFLOW_CODE_IN_PROCESS: 'true' }),
    ...options.env,
  };

  const next = createRequire(join(WEB_DIR, 'package.json')).resolve('next/dist/bin/next');
  const args = options.prod ? [next, 'start', '--port', String(port)] : [next, 'dev', '--port', String(port)];
  const child = spawn(process.execPath, args, { cwd: WEB_DIR, env, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((done) => {
        const force = setTimeout(() => child.kill('SIGKILL'), 8_000);
        child.once('exit', () => {
          clearTimeout(force);
          done();
        });
      });
    }
    log.end();
    if (ownsDir) rmSync(dataDir, { recursive: true, force: true });
    rmSync(logFile, { force: true });
  };
  // A crashed runner must not leave a host behind.
  process.once('exit', () => child.kill('SIGKILL'));

  try {
    await waitForHealth(url, child, logFile, options.timeoutMs ?? 240_000);
  } catch (error) {
    await stop();
    throw error;
  }
  return { url, port, dataDir, logFile, stop };
}

/** Whether a production build exists (the CSP smoke test on `next start`). */
export const hasProductionBuild = () => existsSync(join(WEB_DIR, '.next', 'BUILD_ID'));
