/**
 * What this machine lets the runner apply to each snippet, probed once at startup.
 *
 * Layers, outermost first (each one is skipped where it's unavailable; /v1/info and the startup log list them):
 * 1. The container (deploy/compose.yml): an internal network with no egress, read-only root filesystem, no
 *    capabilities, no-new-privileges, pids/memory/CPU limits. **That is the security boundary**; everything below is
 *    defence in depth, and all a development run without Docker gets.
 * 2. An OS sandbox per snippet: `sandbox-exec` on macOS (no network, no writes outside the work directory, no signals
 *    to other processes); `unshare -rn` (an empty network namespace) on Linux when unprivileged user namespaces work,
 *    which they don't inside the container.
 * 3. Resource limits through `ulimit`: CPU seconds, file size, no core dumps, and on Linux the address space of a
 *    Python snippet. Memory is also watched from outside (/proc on Linux, `ps` on macOS), and V8's heap is capped.
 * 4. Node's permission model for JavaScript (file access, child processes, workers, addons; the network on Node 25+),
 *    and guards inside each child (sandbox.ts, child/).
 */
import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RunnerConfig } from './config';

const run = promisify(execFile);

export interface Isolation {
  platform: NodeJS.Platform;
  osSandbox: 'sandbox-exec' | 'unshare' | null;
  /** `fileSizeBlock`: the unit of `ulimit -f` in this /bin/sh (POSIX says 512 bytes; bash and macOS use 1024). */
  ulimit: { cpu: boolean; fileSize: boolean; fileSizeBlock: number; core: boolean; addressSpace: boolean };
  /** How the runner reads a snippet's resident memory. */
  rssWatch: 'proc' | 'ps' | null;
  node: { path: string; version: string; permission: boolean; netPermission: boolean };
  /** `path` is absolute (sys.executable). */
  python: { path: string; version: string } | null;
}

async function succeeds(file: string, args: string[]): Promise<boolean> {
  try {
    await run(file, args, { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function output(file: string, args: string[]): Promise<string | null> {
  try {
    return (await run(file, args, { timeout: 10_000 })).stdout.trim();
  } catch {
    return null;
  }
}

const ulimit = (flag: string) => succeeds('/bin/sh', ['-c', `ulimit ${flag}`]);

/** 1024 if a 600-byte file fits under `ulimit -f 1`, else 512. */
async function fileSizeBlock(dir: string): Promise<number> {
  const file = join(dir, `code-runner-probe-${process.pid}`);
  try {
    return (await succeeds('/bin/sh', ['-c', 'ulimit -f 1 && dd if=/dev/zero of="$1" bs=600 count=1 2>/dev/null', 'sh', file])) ? 1024 : 512;
  } finally {
    rmSync(file, { force: true });
  }
}

export async function probeIsolation(config: RunnerConfig): Promise<Isolation> {
  const platform = process.platform;
  const [cpu, fileSize, block, core, addressSpace, nodeVersion, permission, netPermission, pythonProbe] = await Promise.all([
    ulimit('-S -t 5 && ulimit -H -t 6'),
    ulimit('-f 2048'),
    fileSizeBlock(config.tmpDir),
    ulimit('-c 0'),
    platform === 'linux' ? ulimit('-v 4000000') : Promise.resolve(false),
    output(config.nodePath, ['-p', 'process.version']),
    succeeds(config.nodePath, ['--permission', '-e', '0']),
    succeeds(config.nodePath, ['--permission', '--allow-net', '-e', '0']),
    // The absolute path: snippets run with a minimal PATH, which may find another python3.
    output(config.pythonPath, ['-I', '-S', '-c', 'import sys; print(sys.version.split()[0]); print(sys.executable)']),
  ]);
  if (!nodeVersion) throw new Error(`Node.js at ${config.nodePath} doesn't run`);
  const python = pythonProbe?.split('\n').map((line) => line.trim());
  let osSandbox: Isolation['osSandbox'] = null;
  if (config.osSandbox && platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    if (await succeeds('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny network*)', '/usr/bin/true'])) osSandbox = 'sandbox-exec';
  } else if (config.osSandbox && platform === 'linux') {
    if (await succeeds('unshare', ['-rn', '/bin/true'])) osSandbox = 'unshare';
  }
  return {
    platform,
    osSandbox,
    ulimit: { cpu, fileSize, fileSizeBlock: block, core, addressSpace },
    rssWatch: platform === 'linux' && existsSync('/proc/self/status') ? 'proc' : platform === 'darwin' ? 'ps' : null,
    node: { path: config.nodePath, version: nodeVersion, permission, netPermission },
    python: python ? { path: python[1], version: python[0] } : null,
  };
}

/** The flat summary /v1/info and the startup log show. */
export function describeIsolation(isolation: Isolation, config: RunnerConfig): Record<string, boolean | string> {
  return {
    osSandbox: isolation.osSandbox ?? 'none',
    cpuLimit: isolation.ulimit.cpu,
    fileSizeLimit: isolation.ulimit.fileSize,
    pythonAddressSpaceLimit: isolation.ulimit.addressSpace,
    memoryWatch: isolation.rssWatch ?? 'none',
    nodePermissionModel: isolation.node.permission,
    nodeNetworkPermission: isolation.node.netPermission,
    guards: config.guards,
  };
}
