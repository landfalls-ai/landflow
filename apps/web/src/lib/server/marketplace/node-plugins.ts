/**
 * Landflow node plugins installed from a marketplace: downloaded to
 * <data dir>/marketplace/plugins/<name>, dependencies installed, then run as child processes the
 * host supervises (restart with backoff, stop on uninstall, output kept in a log). Each one gets
 * its ports through LANDFLOW_HTTP_PORT / LANDFLOW_GRPC_PORT and announces itself to the registry
 * like any other plugin. This runs third-party code: the API asks for an explicit confirmation,
 * and the process gets a minimal environment (no host secrets).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve, sep } from 'node:path';
import type { NodePluginManifest, NodePluginStatus } from '../../shared/marketplace';
import { singleton } from '../singleton';
import { logger } from '../telemetry';
import { recordPluginRestart, traceMarketplace } from '../telemetry/marketplace';
import type { RepoReader } from './reader';

const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const PORT_RANGE = [7250, 7299] as const;
const LOG_LINES = 400;
const STABLE_MS = 60_000;
const MAX_FAST_FAILURES = 8;
const SKIP = /(^|\/)(node_modules|\.git|\.venv|__pycache__)(\/|$)/;

/** The monorepo root (has packages/sdk), for linking the SDK and finding tsx. */
function repoRoot(): string | undefined {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'packages', 'sdk', 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Write the plugin's files; paths are checked to stay inside `dir`. */
export async function downloadPlugin(reader: RepoReader, dir: string): Promise<number> {
  const files = (await reader.list()).filter((f) => !SKIP.test(f.path));
  if (files.length > MAX_FILES) throw new Error(`The plugin has ${files.length} files; the limit is ${MAX_FILES}`);
  const total = files.reduce((sum, f) => sum + (f.size ?? 0), 0);
  if (total > MAX_TOTAL_BYTES) throw new Error(`The plugin is ${Math.round(total / 1024 / 1024)} MB; the limit is ${MAX_TOTAL_BYTES / 1024 / 1024} MB`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const root = resolve(dir);
  for (const file of files) {
    const target = resolve(root, file.path);
    if (!target.startsWith(root + sep)) throw new Error(`Path escapes the plugin directory: ${file.path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, await reader.bytes(file.path, MAX_FILE_BYTES));
  }
  return files.length;
}

/**
 * Node plugins depend on @landflow/sdk, which isn't on npm: point those dependencies at the
 * host's own packages. Returns whether other dependencies still need an npm install.
 */
export function linkSdk(dir: string): boolean {
  const root = repoRoot();
  const packagePath = join(dir, 'package.json');
  const pkg = existsSync(packagePath) ? (JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, Record<string, string> | undefined>) : undefined;
  const local = (name: string) => (root ? join(root, 'packages', name.replace('@landflow/', '')) : undefined);
  let others = false;
  if (pkg) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
      const deps = pkg[field];
      if (!deps) continue;
      for (const name of Object.keys(deps)) {
        const target = name.startsWith('@landflow/') ? local(name) : undefined;
        if (target && existsSync(target)) deps[name] = `file:${target}`;
        else if (field === 'dependencies') others = true;
      }
    }
    writeFileSync(packagePath, JSON.stringify(pkg, null, 2));
  }
  // Without an npm install, link them directly so `import '@landflow/sdk'` resolves.
  for (const name of ['@landflow/sdk', '@landflow/protocol']) {
    const target = local(name);
    const link = join(dir, 'node_modules', name);
    if (!target || !existsSync(target) || existsSync(link)) continue;
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link, 'dir');
  }
  return others;
}

function hostTsx(): string | undefined {
  const root = repoRoot();
  if (!root) return undefined;
  const candidates = [join(root, 'node_modules', '.bin', 'tsx')];
  const plugins = join(root, 'plugins');
  if (existsSync(plugins)) for (const name of readdirSync(plugins)) candidates.push(join(plugins, name, 'node_modules', '.bin', 'tsx'));
  return candidates.find((c) => existsSync(c));
}

/** argv[0] as the host runs it: `node` is this Node, `tsx` the plugin's or the host's. */
export function resolveCommand(argv: string[], dir: string): string[] {
  const [command, ...args] = argv;
  if (command === 'node') return [process.execPath, ...args];
  if (command === 'tsx') {
    const own = join(dir, 'node_modules', '.bin', 'tsx');
    return [existsSync(own) ? own : (hostTsx() ?? 'tsx'), ...args];
  }
  if (command.startsWith('./')) return [resolve(dir, command), ...args];
  return argv;
}

const quote = (arg: string) => (/^[\w./:=@+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);
export const commandLine = (argv: string[]) => argv.map(quote).join(' ');

/** The defaults when the manifest doesn't say how to install. */
export function installCommand(manifest: NodePluginManifest, needsNpm: boolean): string[] | undefined {
  if (manifest.install) return manifest.install;
  if (manifest.runtime === 'node' && needsNpm) return ['npm', 'install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'];
  return undefined;
}

export function registryUrl(): string {
  return process.env.LANDFLOW_MARKETPLACE_REGISTRY_URL ?? process.env.LANDFLOW_PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
}

/** Only what a plugin needs: no API keys, encryption key or tokens from the host. */
function pluginEnv(manifest: NodePluginManifest, ports: { http: number; grpc?: number }): NodeJS.ProcessEnv {
  const pass = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_METRIC_EXPORT_INTERVAL', 'GOPATH', 'GOCACHE', 'GOMODCACHE'];
  return {
    ...Object.fromEntries(pass.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])),
    ...manifest.env,
    NODE_ENV: 'production',
    LANDFLOW_HTTP_PORT: String(ports.http),
    LANDFLOW_GRPC_PORT: ports.grpc ? String(ports.grpc) : 'off',
    LANDFLOW_ADVERTISE_HOST: '127.0.0.1',
    LANDFLOW_REGISTRY_URL: registryUrl(),
    // The host's registry secret, so the plugin can announce itself when one is required.
    ...(process.env.LANDFLOW_REGISTRY_SECRET && { LANDFLOW_REGISTRY_SECRET: process.env.LANDFLOW_REGISTRY_SECRET }),
  };
}

const portFree = (port: number) =>
  new Promise<boolean>((done) => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
  });

export async function freePort(taken: Set<number>): Promise<number> {
  for (let port = PORT_RANGE[0]; port <= PORT_RANGE[1]; port++) {
    if (!taken.has(port) && (await portFree(port))) return port;
  }
  throw new Error(`No free port in ${PORT_RANGE[0]}-${PORT_RANGE[1]} for the plugin`);
}

/** Run a one-off command (dependency install); rejects with the output's tail on failure. */
export function runOnce(argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv; log: (line: string) => void; timeoutMs?: number }): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const [command, ...args] = argv;
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail: string[] = [];
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        options.log(line);
        tail.push(line);
        if (tail.length > 20) tail.shift();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? INSTALL_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`${command}: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`${commandLine(argv)} failed (${signal ?? `exit ${code}`}):\n${tail.join('\n')}`));
    });
  });
}

export interface SupervisedPlugin {
  /** Installed plugin id (`name@marketplace`). */
  key: string;
  pluginId: string;
  dir: string;
  manifest: NodePluginManifest;
  port: number;
  grpcPort?: number;
}

interface Proc {
  spec: SupervisedPlugin;
  child?: ChildProcess;
  status: NodePluginStatus;
  stopping: boolean;
  timer?: NodeJS.Timeout;
  failures: number;
  logs: string[];
  logFile: string;
}

export const nodePlugins = singleton('marketplace-node-plugins', () => {
  const procs = new Map<string, Proc>();

  const append = (proc: Proc, line: string) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    proc.logs.push(stamped);
    if (proc.logs.length > LOG_LINES) proc.logs.splice(0, proc.logs.length - LOG_LINES);
    try {
      appendFileSync(proc.logFile, `${stamped}\n`);
    } catch {}
  };

  function launch(proc: Proc) {
    const { spec } = proc;
    const argv = resolveCommand(spec.manifest.start, spec.dir);
    proc.status = { ...proc.status, state: 'starting', port: spec.port };
    append(proc, `$ ${commandLine(argv)}`);
    const started = Date.now();
    let child: ChildProcess;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: spec.dir, env: pluginEnv(spec.manifest, { http: spec.port, grpc: spec.grpcPort }), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      append(proc, `failed to start: ${(error as Error).message}`);
      proc.status = { ...proc.status, state: 'crashed', lastExit: (error as Error).message };
      return;
    }
    proc.child = child;
    proc.status = { ...proc.status, state: 'running', pid: child.pid, startedAt: new Date(started).toISOString() };
    const onData = (chunk: Buffer) => chunk.toString('utf8').split('\n').filter(Boolean).forEach((line) => append(proc, line));
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', (error) => append(proc, `process error: ${error.message}`));
    child.once('exit', (code, signal) => {
      proc.child = undefined;
      const exit = signal ? `signal ${signal}` : `exit ${code}`;
      append(proc, `process ended (${exit})`);
      if (proc.stopping) {
        proc.status = { state: 'stopped', restarts: proc.status.restarts, lastExit: exit, port: spec.port };
        return;
      }
      // A run that lasted a while resets the backoff.
      proc.failures = Date.now() - started > STABLE_MS ? 1 : proc.failures + 1;
      if (proc.failures > MAX_FAST_FAILURES) {
        proc.status = { ...proc.status, state: 'crashed', pid: undefined, lastExit: exit };
        logger.warn('marketplace plugin keeps crashing; stopped restarting it', { 'landflow.plugin.id': spec.pluginId, 'process.exit': exit });
        return;
      }
      const delay = Math.min(60_000, 1_000 * 2 ** (proc.failures - 1));
      proc.status = { ...proc.status, state: 'restarting', pid: undefined, restarts: proc.status.restarts + 1, lastExit: exit };
      recordPluginRestart(spec.pluginId, exit);
      logger.warn('marketplace plugin exited; restarting', { 'landflow.plugin.id': spec.pluginId, 'process.exit': exit, 'landflow.restart.delay_ms': delay });
      proc.timer = setTimeout(() => launch(proc), delay);
      proc.timer.unref?.();
    });
  }

  function stopProc(proc: Proc): Promise<void> {
    proc.stopping = true;
    if (proc.timer) clearTimeout(proc.timer);
    const child = proc.child;
    if (!child || child.exitCode !== null) {
      proc.status = { ...proc.status, state: 'stopped', pid: undefined };
      return Promise.resolve();
    }
    return new Promise((done) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), 5_000);
      child.once('exit', () => {
        clearTimeout(kill);
        done();
      });
      child.kill('SIGTERM');
    });
  }

  // Don't leave plugins running when the host goes away.
  process.once('exit', () => {
    for (const proc of procs.values()) proc.child?.kill('SIGTERM');
  });

  return {
    logDir: (dataDir: string) => join(dataDir, 'logs'),

    /** Install dependencies of a downloaded plugin. */
    async prepare(spec: Omit<SupervisedPlugin, 'port'>, logFile: string): Promise<string | undefined> {
      mkdirSync(dirname(logFile), { recursive: true });
      const log = (line: string) => {
        try {
          appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
        } catch {}
      };
      const needsNpm = spec.manifest.runtime === 'node' ? linkSdk(spec.dir) : false;
      const install = installCommand(spec.manifest, needsNpm);
      if (!install) return undefined;
      log(`$ ${commandLine(install)}`);
      await traceMarketplace('deps', { 'landflow.plugin.id': spec.pluginId, 'process.command': install[0] }, () =>
        runOnce(resolveCommand(install, spec.dir), { cwd: spec.dir, env: pluginEnv(spec.manifest, { http: 0 }), log }),
      );
      // npm may have replaced the links; make sure the SDK still resolves.
      if (spec.manifest.runtime === 'node') linkSdk(spec.dir);
      return commandLine(install);
    },

    start(spec: SupervisedPlugin, logFile: string) {
      const existing = procs.get(spec.key);
      if (existing?.child) return existing.status;
      if (existing?.timer) clearTimeout(existing.timer);
      mkdirSync(dirname(logFile), { recursive: true });
      const proc: Proc = { spec, status: { state: 'starting', restarts: 0, port: spec.port }, stopping: false, failures: 0, logs: existing?.logs ?? [], logFile };
      procs.set(spec.key, proc);
      launch(proc);
      return proc.status;
    },

    async stop(key: string) {
      const proc = procs.get(key);
      if (!proc) return;
      await stopProc(proc);
      procs.delete(key);
    },

    status(key: string): NodePluginStatus | undefined {
      return procs.get(key)?.status;
    },

    logs(key: string, logFile?: string): string[] {
      const proc = procs.get(key);
      if (proc?.logs.length) return proc.logs;
      if (logFile && existsSync(logFile) && statSync(logFile).size < 2 * 1024 * 1024) return readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-LOG_LINES);
      return [];
    },

    ports(): Set<number> {
      return new Set([...procs.values()].flatMap((p) => [p.spec.port, ...(p.spec.grpcPort ? [p.spec.grpcPort] : [])]));
    },
  };
});
