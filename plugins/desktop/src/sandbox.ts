/**
 * The sandbox driver: starts, talks to and removes the disposable desktop (services/desktop-sandbox).
 *
 * `DockerDriver` runs the real thing through the local Docker engine's CLI, never through a shell: one argument per word,
 * a hardened container (read-only root, no capabilities, no mounts, limits), and egress `--network none` unless hosts are
 * allowed, when the sandbox sits on its own internal network behind an allow-list proxy. `ScriptedDriver` is the same
 * contract with no container, for tests and for demos with no Docker and no model.
 */
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export type ActionName = 'screenshot' | 'click' | 'move' | 'type' | 'key' | 'scroll' | 'drag' | 'wait' | 'launch';
export const ACTIONS: ActionName[] = ['screenshot', 'click', 'move', 'type', 'key', 'scroll', 'drag', 'wait', 'launch'];

export interface SandboxAction {
  action: ActionName;
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  button?: string;
  count?: number;
  text?: string;
  key?: string;
  direction?: string;
  amount?: number;
  ms?: number;
  app?: string;
}

export interface StartOptions {
  apps: string[];
  startApp?: string;
  allowedHosts: string[];
  maxSteps: number;
  timeLimitSeconds: number;
  idleSeconds: number;
  width: number;
  height: number;
}

export interface ScreenWindow {
  id: string;
  title: string;
  class: string;
  pid: string;
}

/** What the sandbox answers to a step. `png` and `thumb` are base64. */
export interface StepReply {
  ok: boolean;
  error?: string;
  stuck?: boolean;
  steps?: number;
  maxSteps?: number;
  width?: number;
  height?: number;
  png?: string;
  thumb?: string;
  windows?: ScreenWindow[];
  newViolations?: { class: string; title: string; closed: boolean }[];
  violations?: number | { class: string; title: string }[];
  files?: { path: string; size: number }[];
  data?: string;
  path?: string;
  allowed?: string[];
  secondsLeft?: number;
}

export interface SandboxDriver {
  start(options: StartOptions): Promise<string>;
  send(id: string, request: Record<string, unknown>): Promise<StepReply>;
  end(id: string): Promise<void>;
  /** Remove every sandbox past its deadline (all of them with `all`). Returns how many sessions went. */
  sweep(all?: boolean): Promise<number>;
}

export class SandboxError extends Error {
  constructor(message: string, readonly description?: string) {
    super(message);
  }
}

export type DockerRun = (args: string[], options?: { input?: string; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; code: number }>;

export const dockerRun: DockerRun = (args, { input, timeoutMs = 120_000 } = {}) =>
  new Promise((resolve) => {
    const bin = process.env.LANDFLOW_DESKTOP_DOCKER_BIN || 'docker';
    const context = process.env.LANDFLOW_DESKTOP_DOCKER_CONTEXT;
    const argv = context ? ['--context', context, ...args] : args;
    if (input === undefined) {
      execFile(bin, argv, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as NodeJS.ErrnoException).code === 'number' ? ((error as NodeJS.ErrnoException).code as unknown as number) : 1) : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr || (error && (error as Error).message) || ''), code });
      });
      return;
    }
    const child = spawn(bin, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: e.message, code: 1 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
    child.stdin.end(input);
  });

export const PREFIX = 'landflow-desktop';
const LABEL = 'landflow.desktop=1';

/** The flags every sandbox container gets. Exported so a test can check the boundary. */
export function hardening(): string[] {
  return [
    '--rm',
    '--init',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
    '--tmpfs',
    '/home/sandbox:rw,nosuid,nodev,size=256m,uid=10001',
    '--tmpfs',
    '/work:rw,nosuid,nodev,size=64m,uid=10001',
    '--shm-size',
    '512m',
    '--memory',
    process.env.LANDFLOW_DESKTOP_MEMORY || '2g',
    '--cpus',
    process.env.LANDFLOW_DESKTOP_CPUS || '2',
    '--pids-limit',
    '512',
    '--user',
    '10001',
  ];
}

export class DockerDriver implements SandboxDriver {
  constructor(
    private readonly docker: DockerRun = dockerRun,
    private readonly image = process.env.LANDFLOW_DESKTOP_IMAGE || 'landflow/desktop-sandbox:dev',
  ) {}

  /** The argument list of the sandbox's `docker run`, for tests and for the docs. */
  runArgs(id: string, o: StartOptions, deadline: number, network: string, proxy?: string): string[] {
    const env: Record<string, string> = {
      SANDBOX_APPS: o.apps.join(','),
      SANDBOX_START_APP: o.startApp ?? '',
      SANDBOX_MAX_STEPS: String(o.maxSteps),
      SANDBOX_DEADLINE: String(deadline),
      SANDBOX_IDLE_SECONDS: String(o.idleSeconds),
      SANDBOX_WIDTH: String(o.width),
      SANDBOX_HEIGHT: String(o.height),
      ...(proxy && { SANDBOX_PROXY: proxy }),
    };
    return [
      'run',
      '-d',
      ...hardening(),
      '--name',
      `${PREFIX}-${id}`,
      '--label',
      LABEL,
      '--label',
      `landflow.desktop.deadline=${Math.ceil(deadline)}`,
      '--network',
      network,
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      this.image,
    ];
  }

  async start(o: StartOptions): Promise<string> {
    const id = randomBytes(5).toString('hex');
    const deadline = Date.now() / 1000 + o.timeLimitSeconds;
    const name = `${PREFIX}-${id}`;
    let network = 'none';
    let proxy: string | undefined;
    try {
      if (o.allowedHosts.length) {
        network = `${PREFIX}-net-${id}`;
        const made = await this.docker(['network', 'create', '--internal', '--label', LABEL, network]);
        if (made.code) throw new SandboxError('Could not create the sandbox network', made.stderr.trim());
        const created = await this.docker([
          'create',
          ...hardening().filter((a) => !['--init'].includes(a)),
          '--name',
          `${PREFIX}-proxy-${id}`,
          '--label',
          LABEL,
          '--label',
          `landflow.desktop.deadline=${Math.ceil(deadline)}`,
          '--network',
          'bridge',
          '-e',
          `PROXY_ALLOWED_HOSTS=${o.allowedHosts.join(',')}`,
          this.image,
          'python3',
          '/opt/sandbox/proxy.py',
          '3128',
        ]);
        if (created.code) throw new SandboxError('Could not create the egress proxy', created.stderr.trim());
        await this.docker(['network', 'connect', network, `${PREFIX}-proxy-${id}`]);
        const up = await this.docker(['start', `${PREFIX}-proxy-${id}`]);
        if (up.code) throw new SandboxError('Could not start the egress proxy', up.stderr.trim());
        proxy = `${PREFIX}-proxy-${id}:3128`;
      }
      const run = await this.docker(this.runArgs(id, o, deadline, network, proxy));
      if (run.code) {
        const hint = /No such image|pull access denied|not found/i.test(run.stderr) ? ` Build it first: docker buildx build --load -t ${this.image} services/desktop-sandbox` : '';
        throw new SandboxError('Could not start the desktop sandbox', `${run.stderr.trim().slice(0, 400)}${hint}`);
      }
      for (let i = 0; i < 120; i++) {
        const ready = await this.docker(['exec', name, 'test', '-f', '/tmp/ready']);
        if (ready.code === 0) return id;
        const state = await this.docker(['inspect', '-f', '{{.State.Running}}', name]);
        if (state.code || state.stdout.trim() !== 'true') throw new SandboxError('The desktop sandbox stopped while starting');
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new SandboxError('The desktop sandbox did not become ready in 60 seconds');
    } catch (error) {
      await this.end(id);
      throw error;
    }
  }

  async send(id: string, request: Record<string, unknown>): Promise<StepReply> {
    const r = await this.docker(['exec', '-i', `${PREFIX}-${id}`, 'python3', '/opt/sandbox/sandbox.py', 'ctl'], { input: JSON.stringify(request), timeoutMs: 150_000 });
    if (r.code) throw new SandboxError('The desktop sandbox is gone', /No such container|is not running/i.test(r.stderr) ? 'It reached its time limit, was idle too long or was ended.' : r.stderr.trim().slice(0, 300));
    try {
      return JSON.parse(r.stdout) as StepReply;
    } catch {
      throw new SandboxError('The desktop sandbox answered something that is not JSON', r.stdout.slice(0, 200));
    }
  }

  async end(id: string): Promise<void> {
    await this.docker(['rm', '-f', `${PREFIX}-${id}`, `${PREFIX}-proxy-${id}`]);
    await this.docker(['network', 'rm', `${PREFIX}-net-${id}`]);
  }

  async sweep(all = false): Promise<number> {
    const listed = await this.docker(['ps', '-a', '--filter', 'label=landflow.desktop=1', '--format', '{{.Names}}\t{{.Label "landflow.desktop.deadline"}}']);
    if (listed.code) return 0;
    const now = Date.now() / 1000;
    const ids = new Set<string>();
    for (const line of listed.stdout.split('\n').filter(Boolean)) {
      const [name, deadline] = line.split('\t');
      const m = /^landflow-desktop-(?:proxy-)?([0-9a-f]{10})$/.exec(name ?? '');
      // A grace period past the deadline: the container leaves by itself at it.
      if (m && (all || Number(deadline) + 30 < now)) ids.add(m[1]);
    }
    for (const id of ids) await this.end(id);
    // Networks the sweep did not own a container for (a crash between create and run).
    const nets = await this.docker(['network', 'ls', '--filter', 'label=landflow.desktop=1', '--format', '{{.Name}}']);
    for (const name of nets.stdout.split('\n').filter((n) => /^landflow-desktop-net-[0-9a-f]{10}$/.test(n))) await this.docker(['network', 'rm', name]);
    return ids.size;
  }
}

/** A 1x1-ish valid PNG the scripted driver returns (grey), so image plumbing can be tested without a display. */
export const SCRIPTED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHEhCmQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * No container: a scripted desktop with the sandbox's own rules (step budget, bounds, allow-list, stuck detection) so the
 * node can be tested end to end with no Docker and no model. `calls` is every request it saw.
 */
export class ScriptedDriver implements SandboxDriver {
  readonly calls: { id: string; request: Record<string, unknown> }[] = [];
  readonly started: StartOptions[] = [];
  readonly ended: string[] = [];
  private sessions = new Map<string, { steps: number; max: number; apps: string[]; w: number; h: number }>();
  private n = 0;
  files: Record<string, string> = {};
  /** Titles the desktop reports, newest request last: lets a test play a hostile window title. */
  title = 'Untitled 1 - Mousepad';

  async start(o: StartOptions) {
    const id = `scripted${++this.n}`;
    this.started.push(o);
    this.sessions.set(id, { steps: 0, max: o.maxSteps, apps: o.apps, w: o.width, h: o.height });
    return id;
  }

  async send(id: string, request: Record<string, unknown>): Promise<StepReply> {
    this.calls.push({ id, request });
    const s = this.sessions.get(id);
    if (!s) throw new SandboxError('The desktop sandbox is gone');
    const a = request.action as string;
    if (a === 'file_list') return { ok: true, files: Object.entries(this.files).map(([path, t]) => ({ path, size: t.length })) };
    if (a === 'file_get') {
      const t = this.files[String(request.path)];
      return t === undefined ? { ok: false, error: 'no such file, or it is over 1 MB' } : { ok: true, path: String(request.path), data: Buffer.from(t).toString('base64') };
    }
    if (a === 'file_put') {
      this.files[String(request.path)] = Buffer.from(String(request.data), 'base64').toString();
      return { ok: true, path: String(request.path) };
    }
    if (a !== 'screenshot') {
      if (s.steps >= s.max) return { ok: false, error: `step budget of ${s.max} used` };
      s.steps++;
    }
    if (a === 'click' || a === 'move') {
      const [x, y] = [request.x as number, request.y as number];
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= s.w || y >= s.h) return { ok: false, error: `(${x}, ${y}) is outside the ${s.w}x${s.h} screen`, steps: s.steps };
    }
    if (a === 'launch' && !s.apps.includes(String(request.app))) return { ok: false, error: `'${request.app}' is not an allowed app (allowed: ${s.apps.join(', ') || 'none'})`, steps: s.steps };
    return {
      ok: true,
      width: s.w,
      height: s.h,
      steps: s.steps,
      maxSteps: s.max,
      stuck: false,
      png: SCRIPTED_PNG.toString('base64'),
      thumb: SCRIPTED_PNG.toString('base64'),
      windows: [{ id: '1', title: this.title, class: '', pid: '1' }],
      newViolations: [],
      violations: 0,
    };
  }

  async end(id: string) {
    this.ended.push(id);
    this.sessions.delete(id);
  }

  async sweep() {
    return 0;
  }
}
