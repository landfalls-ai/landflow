/**
 * Landflow node plugins installed from a marketplace: downloaded to
 * <data dir>/marketplace/plugins/<name>, dependencies installed, then run as child processes the
 * host supervises (restart with backoff, stop on uninstall, output kept in a log). Each one gets
 * its ports through LANDFLOW_HTTP_PORT / LANDFLOW_GRPC_PORT and announces itself to the registry
 * like any other plugin. This runs third-party code: the API asks for an explicit confirmation,
 * and the process gets a minimal environment (no host secrets).
 *
 * Queue mode (./service.ts, `syncNodePlugins`): every main and worker runs its own copy of each installed plugin, from
 * the same source and content (a hash of the downloaded files, checked again on each process), and registers it in its
 * own registry as a process-local endpoint instead of announcing it (`announce: false`).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { NodePluginManifest, NodePluginStatus } from '../../shared/marketplace';
import { singleton } from '../singleton';
import { logger } from '../telemetry';
import { recordPluginRestart, traceMarketplace } from '../telemetry/marketplace';
import type { RepoFile, RepoReader } from './reader';

const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const PORT_RANGE = [7250, 7299] as const;

/** The ports node plugins get: LANDFLOW_MARKETPLACE_PORTS (`7250-7299`, the default), e.g. one range per process on a host. */
export function portRange(setting = process.env.LANDFLOW_MARKETPLACE_PORTS): readonly [number, number] {
  const match = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(setting ?? '');
  const [low, high] = match ? [Number(match[1]), Number(match[2])] : PORT_RANGE;
  return low >= 1024 && high <= 65535 && low <= high ? [low, high] : PORT_RANGE;
}
const LOG_LINES = 400;
const STABLE_MS = 60_000;
const MAX_FAST_FAILURES = 8;
const SKIP = /(^|\/)(node_modules|\.git|\.venv|__pycache__)(\/|$)/;
/** Written into a plugin's directory once it is downloaded and prepared: which install it holds. */
export const INSTALL_MARKER = '.landflow-install.json';

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

/** The plugin's files, without dependency folders, within the size limits. */
export async function pluginFiles(reader: RepoReader): Promise<RepoFile[]> {
  const files = (await reader.list()).filter((f) => !SKIP.test(f.path));
  if (files.length > MAX_FILES) throw new Error(`The plugin has ${files.length} files; the limit is ${MAX_FILES}`);
  const total = files.reduce((sum, f) => sum + (f.size ?? 0), 0);
  if (total > MAX_TOTAL_BYTES) throw new Error(`The plugin is ${Math.round(total / 1024 / 1024)} MB; the limit is ${MAX_TOTAL_BYTES / 1024 / 1024} MB`);
  return files;
}

/** Read one file of the plugin, within the per-file limit. */
export const pluginFile = (reader: RepoReader, path: string) => reader.bytes(path, MAX_FILE_BYTES);

/** Write the plugin's files; paths are checked to stay inside `dir`. */
export async function downloadPlugin(reader: RepoReader, dir: string): Promise<number> {
  const files = await pluginFiles(reader);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const root = resolve(dir);
  for (const file of files) {
    const target = resolve(root, file.path);
    if (!target.startsWith(root + sep)) throw new Error(`Path escapes the plugin directory: ${file.path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, await pluginFile(reader, file.path));
  }
  return files.length;
}

/** A hash of a downloaded plugin's files (before dependencies are installed): processes check they run the same code. */
export function contentHash(dir: string): string {
  const root = resolve(dir);
  const files: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      const path = relative(root, full).split(sep).join('/');
      if (SKIP.test(path) || path === INSTALL_MARKER) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(root);
  const hash = createHash('sha256');
  for (const path of files.sort()) hash.update(`${path}\u0000`).update(readFileSync(join(root, path))).update('\u0000');
  return `sha256:${hash.digest('hex')}`;
}

export interface InstallMarker {
  key: string;
  revision: string;
  contentHash: string;
}

export function readInstallMarker(dir: string): InstallMarker | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, INSTALL_MARKER), 'utf8')) as InstallMarker;
  } catch {
    return undefined;
  }
}

export function writeInstallMarker(dir: string, marker: InstallMarker) {
  writeFileSync(join(dir, INSTALL_MARKER), JSON.stringify(marker, null, 2));
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

const GO_SDK_MODULE = 'github.com/landflow/landflow/sdks/go';

/**
 * Go plugins reach the SDK (and its transport modules) through `replace` directives with paths relative to the repo,
 * like `=> ../../sdks/go`, which point nowhere once the plugin is downloaded. Point them at the host's own `sdks/go`.
 * Returns how many directives changed.
 */
export function linkGoSdk(dir: string): number {
  const root = repoRoot();
  const modPath = join(dir, 'go.mod');
  if (!root || !existsSync(modPath)) return 0;
  let changed = 0;
  const pattern = new RegExp(`(${GO_SDK_MODULE.replace(/[.]/g, '\\.')})((?:/[\\w.-]+)*)(\\s+(?:v[\\w.+-]+\\s+)?=>\\s+)(\\S+)`, 'g');
  const text = readFileSync(modPath, 'utf8').replace(pattern, (whole, module: string, sub: string, arrow: string, target: string) => {
    if (!target.startsWith('.')) return whole;
    const local = join(root, 'sdks', 'go', ...sub.split('/').filter(Boolean));
    if (!existsSync(local)) return whole;
    changed++;
    return `${module}${sub}${arrow}${local}`;
  });
  if (changed) writeFileSync(modPath, text);
  return changed;
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

/** Only what a plugin needs: no API keys, encryption key or tokens from the host. `announce: false`: the host registers it itself. */
function pluginEnv(manifest: NodePluginManifest, ports: { http: number; grpc?: number }, announce = true): NodeJS.ProcessEnv {
  const pass = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_METRIC_EXPORT_INTERVAL', 'GOPATH', 'GOCACHE', 'GOMODCACHE'];
  return {
    ...Object.fromEntries(pass.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])),
    ...manifest.env,
    NODE_ENV: 'production',
    LANDFLOW_HTTP_PORT: String(ports.http),
    LANDFLOW_GRPC_PORT: ports.grpc ? String(ports.grpc) : 'off',
    LANDFLOW_ADVERTISE_HOST: '127.0.0.1',
    LANDFLOW_REGISTRY_URL: announce ? registryUrl() : 'off',
    // The host's registry secret, so the plugin can announce itself when one is required.
    ...(announce && process.env.LANDFLOW_REGISTRY_SECRET && { LANDFLOW_REGISTRY_SECRET: process.env.LANDFLOW_REGISTRY_SECRET }),
  };
}

/** Something takes a connection on the port: a listener on any interface answers on 127.0.0.1 too. */
const answers = (port: number) =>
  new Promise<boolean>((done) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const finish = (value: boolean) => {
      socket.destroy();
      done(value);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });

/**
 * Free when nothing answers on it and it binds on every interface, as the plugins' servers do. Binding 127.0.0.1 alone
 * isn't proof: on macOS it succeeds while another process holds the port on the wildcard address.
 */
export const portFree = async (port: number) =>
  !(await answers(port)) &&
  new Promise<boolean>((done) => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen(port, () => server.close(() => done(true)));
  });

export async function freePort(taken: Set<number>): Promise<number> {
  const [low, high] = portRange();
  for (let port = low; port <= high; port++) {
    if (!taken.has(port) && (await portFree(port))) return port;
  }
  throw new Error(`No free port in ${low}-${high} for the plugin (LANDFLOW_MARKETPLACE_PORTS)`);
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
  /** Queue mode: don't announce (LANDFLOW_REGISTRY_URL=off); the process registers it in its own registry. */
  announce?: boolean;
  /** The install it runs (a new one, or an update, restarts it). */
  revision?: string;
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
      child = spawn(argv[0], argv.slice(1), { cwd: spec.dir, env: pluginEnv(spec.manifest, { http: spec.port, grpc: spec.grpcPort }, spec.announce !== false), stdio: ['ignore', 'pipe', 'pipe'] });
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
      if (spec.manifest.runtime === 'go' && linkGoSdk(spec.dir)) log('pointed go.mod at the host’s sdks/go');
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

    /** What runs here (queue mode compares it with the installed list). */
    specs(): SupervisedPlugin[] {
      return [...procs.values()].map((p) => p.spec);
    },
  };
});
