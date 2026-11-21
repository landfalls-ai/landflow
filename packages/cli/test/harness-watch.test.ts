/**
 * `landflow harness watch codex` (C05 FR-5, FR-6, AS-4..AS-6; C08): the rollout watch reads only sessions it started, bounds its
 * reads, reports one `quota_blocked` event per stopped turn and nothing else, and the command runs Codex under it.
 * Fixture JSONL files in a temp folder; no real Codex.
 */
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Io } from '../src/command';
import { run } from '../src/index';
import type { HarnessChild, WatchIo } from '../src/commands/harness';
import { watchRollouts, type QuotaBlockedEvent } from '../src/harness/rollout-watch';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const scratch = mkdtempSync(join(tmpdir(), 'landflow-harness-watch-'));
let counter = 0;

/** A fresh sessions folder with today's date layout, as Codex makes it. */
function sessions() {
  const dir = join(scratch, `codex-${++counter}`, 'sessions');
  const now = new Date();
  const day = join(dir, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  mkdirSync(day, { recursive: true });
  return { dir, day };
}
const uuid = (n: number) => `0199aaaa-bbbb-cccc-dddd-${String(n).padStart(12, '0')}`;
const rollout = (day: string, n: number) => join(day, `rollout-2026-11-21T10-00-00-${uuid(n)}.jsonl`);
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const meta = (id: string) => line({ type: 'session_meta', payload: { id, cwd: '/home/dev/private/project' } });
const turn = () => line({ type: 'turn_context', payload: { cwd: '/home/dev/private/project', model: 'gpt' } });
const prompt = (text: string) => line({ type: 'event_msg', payload: { type: 'user_message', message: text } });
const complete = (error?: Record<string, unknown>) => line({ type: 'event_msg', payload: { type: 'task_complete', ...(error && { error }) } });
const LIMIT = { message: 'You have hit your usage limit', codex_error_info: 'usage_limit_exceeded' };

function watching(dir: string, extra: Partial<Parameters<typeof watchRollouts>[0]> = {}) {
  const posted: QuotaBlockedEvent[] = [];
  const watch = watchRollouts({ dir, since: Date.now(), tickMs: 0, post: async (event) => void posted.push(event), ...extra });
  return { watch, posted };
}
/** `since` is taken, then the file is made a moment later so its birth time is after it. */
const later = () => sleep(15);

const open: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  while (open.length) await open.pop()!.stop();
});
const track = <T extends { stop(): Promise<void> }>(watch: T): T => (open.push(watch), watch);

describe('the rollout watch', () => {
  it('posts one quota_blocked event with the kind and message when a started session’s turn ends on a usage limit, and nothing else from the file (AS-4)', async () => {
    const { dir, day } = sessions();
    const { watch, posted } = watching(dir);
    track(watch);
    await later();
    const file = rollout(day, 1);
    writeFileSync(file, meta(uuid(1)) + turn() + prompt('SECRET PROMPT /etc/passwd'));
    await watch.tick();
    expect(posted).toEqual([]);
    appendFileSync(file, complete(LIMIT));
    await watch.tick();
    expect(posted).toEqual([{ hook_event_name: 'quota_blocked', session_id: uuid(1), kind: 'usage_limit', message: 'You have hit your usage limit' }]);
    expect(JSON.stringify(posted)).not.toMatch(/SECRET|passwd|home|cwd|private/);
    expect(Object.keys(posted[0]!).sort()).toEqual(['hook_event_name', 'kind', 'message', 'session_id']);
    // The same turn is reported once, however often it is read.
    await watch.tick();
    await watch.tick();
    expect(posted).toHaveLength(1);
    expect(watch.delivered).toBe(1);
  });

  it('reads credits depleted from the last token_count, and falls back on the file name for the session id', async () => {
    const { dir, day } = sessions();
    const { watch, posted } = watching(dir);
    track(watch);
    await later();
    writeFileSync(rollout(day, 2), turn() + line({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { rate_limit_reached_type: 'workspace_member_credits_depleted' } } }) + complete(LIMIT));
    await watch.tick();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ kind: 'credits_depleted', session_id: uuid(2) });
  });

  it('never reads a session that began before the watch (the person started it elsewhere)', async () => {
    const { dir, day } = sessions();
    writeFileSync(rollout(day, 3), meta(uuid(3)) + turn() + complete(LIMIT));
    await later();
    const { watch, posted } = watching(dir);
    track(watch);
    await watch.tick();
    appendFileSync(rollout(day, 3), turn() + complete(LIMIT));
    await watch.tick();
    expect(posted).toEqual([]);
    expect(watch.open).toBe(0);
  });

  it('starts at most 64 KB before the end of a big file, and reads at most 256 KB per tick (AS-5)', async () => {
    const { dir, day } = sessions();
    const { watch, posted } = watching(dir);
    track(watch);
    await later();
    const file = rollout(day, 4);
    // 10 MB of filler with a limit stop at the very start: only a read from the start would find it.
    const filler = line({ type: 'event_msg', payload: { type: 'agent_message', message: 'x'.repeat(2_000) } });
    writeFileSync(file, meta(uuid(4)) + turn() + complete(LIMIT) + filler.repeat(Math.ceil(10_000_000 / filler.length)));
    await watch.tick();
    expect(posted).toEqual([]);
    expect(watch.open).toBe(1);
    // Then 1 MB is appended ending in a stop: a tick reads 256 KB, so the stop arrives only after a few ticks.
    appendFileSync(file, turn() + filler.repeat(Math.ceil(1_000_000 / filler.length)) + turn() + complete(LIMIT));
    await watch.tick();
    expect(posted).toEqual([]);
    for (let i = 0; i < 6 && !posted.length; i++) await watch.tick();
    expect(posted).toHaveLength(1);
  });

  it('closes a file replaced at the same path after reading what the old one held, and posts nothing for the new one (AS-6)', async () => {
    const { dir, day } = sessions();
    const { watch, posted } = watching(dir);
    track(watch);
    await later();
    const file = rollout(day, 5);
    writeFileSync(file, meta(uuid(5)) + turn());
    await watch.tick();
    expect(watch.open).toBe(1);
    appendFileSync(file, complete(LIMIT));
    const other = `${file}.other`;
    writeFileSync(other, meta(uuid(6)) + turn() + complete(LIMIT));
    renameSync(other, file);
    await watch.tick();
    expect(posted.map((e) => e.session_id)).toEqual([uuid(5)]);
    expect(watch.open).toBe(0);
    await watch.tick();
    expect(posted).toHaveLength(1);
  });

  it('reads what is left of a file that was removed, then closes', async () => {
    const { dir, day } = sessions();
    const { watch, posted } = watching(dir);
    track(watch);
    await later();
    const file = rollout(day, 7);
    writeFileSync(file, meta(uuid(7)) + turn());
    await watch.tick();
    appendFileSync(file, complete(LIMIT));
    rmSync(file);
    await watch.tick();
    expect(posted).toHaveLength(1);
    expect(watch.open).toBe(0);
  });

  it('a turn that completes without an error, is aborted or is followed by a newer turn posts nothing; a later turn that stops on a limit still does', async () => {
    const { dir, day } = sessions();
    const { watch, posted } = watching(dir);
    track(watch);
    await later();
    const file = rollout(day, 8);
    writeFileSync(file, meta(uuid(8)) + turn() + complete());
    await watch.tick();
    appendFileSync(file, turn() + line({ type: 'event_msg', payload: { type: 'turn_aborted' } }));
    await watch.tick();
    appendFileSync(file, turn() + line({ type: 'event_msg', payload: { type: 'agent_message', message: 'working' } }) + turn());
    await watch.tick();
    expect(posted).toEqual([]);
    // A different Codex error is an ordinary error, not Blocked.
    appendFileSync(file, turn() + complete({ message: 'boom', codex_error_info: 'other' }));
    await watch.tick();
    expect(posted).toEqual([]);
    appendFileSync(file, turn() + complete(LIMIT));
    await watch.tick();
    expect(posted).toHaveLength(1);
  });

  it('never times out a turn that has no completion', async () => {
    const { dir, day } = sessions();
    const { watch, posted } = watching(dir);
    track(watch);
    await later();
    const file = rollout(day, 9);
    writeFileSync(file, meta(uuid(9)) + turn() + prompt('long task'));
    for (let i = 0; i < 20; i++) await watch.tick();
    expect(watch.open).toBe(1);
    appendFileSync(file, complete(LIMIT));
    await watch.tick();
    expect(posted).toHaveLength(1);
  });

  it('waits for the end of a half-written line, and ignores lines that are not JSON', async () => {
    const { dir, day } = sessions();
    const { watch, posted } = watching(dir);
    track(watch);
    await later();
    const file = rollout(day, 10);
    const stop = complete(LIMIT);
    writeFileSync(file, meta(uuid(10)) + turn() + 'not json at all\n' + stop.slice(0, 30));
    await watch.tick();
    expect(posted).toEqual([]);
    appendFileSync(file, stop.slice(30));
    await watch.tick();
    expect(posted).toHaveLength(1);
  });

  it('retries a post that fails and gives up after five tries', async () => {
    const { dir, day } = sessions();
    let attempts = 0;
    const gaveUp = vi.fn();
    const { watch } = watching(dir, {
      post: async () => {
        attempts++;
        if (attempts < 3) throw new Error('down');
      },
      onGiveUp: gaveUp,
    });
    track(watch);
    await later();
    writeFileSync(rollout(day, 11), meta(uuid(11)) + turn() + complete(LIMIT));
    for (let i = 0; i < 4; i++) await watch.tick();
    expect(attempts).toBe(3);
    expect(watch.delivered).toBe(1);
    expect(gaveUp).not.toHaveBeenCalled();

    const dead = sessions();
    const failing = watching(dead.dir, { post: async () => Promise.reject(new Error('down')), onGiveUp: gaveUp });
    track(failing.watch);
    await later();
    writeFileSync(rollout(dead.day, 12), meta(uuid(12)) + turn() + complete(LIMIT));
    for (let i = 0; i < 8; i++) await failing.watch.tick();
    expect(gaveUp).toHaveBeenCalledTimes(1);
  });

  it('stop reads what Codex wrote just before it exited', async () => {
    const { dir, day } = sessions();
    const { watch, posted } = watching(dir);
    await later();
    const file = rollout(day, 13);
    writeFileSync(file, meta(uuid(13)) + turn());
    await watch.tick();
    appendFileSync(file, complete(LIMIT));
    await watch.stop();
    expect(posted).toHaveLength(1);
    expect(watch.open).toBe(0);
  });
});

// ---- the command ----

const home = mkdtempSync(join(tmpdir(), 'landflow-harness-watch-home-'));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  fetch: ReturnType<typeof vi.fn>;
  started: Array<{ binary: string; args: string[] }>;
}
async function watchRun(args: string[], options: { env?: Record<string, string>; child?: (dir: string) => Promise<number> | number; status?: number } = {}): Promise<Run> {
  const { dir, day } = sessions();
  void day;
  let stdout = '';
  let stderr = '';
  const started: Run['started'] = [];
  const fetch = vi.fn(async () => new Response(null, { status: options.status ?? 204 }));
  const io: WatchIo = {
    stdout: (t) => void (stdout += t),
    stderr: (t) => void (stderr += t),
    readStdin: async () => '',
    env: { LANDFLOW_URL: 'http://landflow.test', LANDFLOW_API_KEY: 'lf_test_key', CODEX_HOME: join(dir, '..'), ...options.env },
    cwd: scratch,
    home,
    interactive: false,
    prompt: async () => '',
    fetch: fetch as unknown as typeof globalThis.fetch,
    sleep: async () => {},
    startHarness: (binary, argv): HarnessChild => {
      started.push({ binary, args: argv });
      return { exit: (async () => options.child?.(dir) ?? 0)(), stop() {} };
    },
  };
  const code = await run(args, io as Io);
  return { code, stdout, stderr, fetch, started };
}
/** A fake Codex: waits a moment (so its files are born after the watch began), writes a rollout that stops on a limit, exits. */
const fakeCodex = (n: number, exit = 0) => async (dir: string) => {
  await sleep(20);
  const now = new Date();
  const day = join(dir, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  mkdirSync(day, { recursive: true });
  writeFileSync(rollout(day, n), meta(uuid(n)) + turn() + prompt('PRIVATE PROMPT') + complete(LIMIT));
  return exit;
};

describe('landflow harness watch codex', () => {
  it('runs codex with the arguments after --, reports a blocked turn with the stored key, and exits with codex’s code (T-9)', async () => {
    const result = await watchRun(['harness', 'watch', 'codex', '--json', '--', '--model', 'gpt-x'], { child: fakeCodex(20, 3) });
    expect(result.started).toEqual([{ binary: 'codex', args: ['--model', 'gpt-x'] }]);
    expect(result.code).toBe(3);
    expect(result.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = result.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://landflow.test/api/harness/codex/hooks');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer lf_test_key');
    expect(JSON.parse(String(init.body))).toEqual({ hook_event_name: 'quota_blocked', session_id: uuid(20), kind: 'usage_limit', message: 'You have hit your usage limit' });
    expect(String(init.body)).not.toContain('PRIVATE PROMPT');
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, harness: 'codex', exitCode: 3, reported: 1 });
  });

  it('stops when codex exits: a session that never hit a limit reports nothing', async () => {
    const result = await watchRun(['harness', 'watch', 'codex'], { child: () => 0 });
    expect(result.code).toBe(0);
    expect(result.fetch).not.toHaveBeenCalled();
    expect(result.stderr).toContain('Only a Blocked event is sent');
  });

  it('refuses without a key, naming the harness:write scope, and starts nothing', async () => {
    const result = await watchRun(['harness', 'watch', 'codex'], { env: { LANDFLOW_API_KEY: '' } });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('harness:write');
    expect(result.started).toEqual([]);
  });

  it('says once that the key lacks the scope when the host refuses, and keeps codex running', async () => {
    const result = await watchRun(['harness', 'watch', 'codex'], { child: fakeCodex(21), status: 403 });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('harness:write');
  });

  it('only codex is watched, and a missing codex is "not found"', async () => {
    expect((await watchRun(['harness', 'watch', 'gemini'])).code).toBe(2);
    const missing = await watchRun(['harness', 'watch', 'codex'], { child: () => 127 });
    expect(missing.code).toBe(3);
    expect(missing.stderr).toContain('codex is not on PATH');
  });

  it('is listed in the command help', async () => {
    let out = '';
    const code = await run(['harness'], { stdout: (t: string) => void (out += t), stderr: () => {}, readStdin: async () => '', env: {}, cwd: scratch, home, interactive: false, prompt: async () => '', fetch: globalThis.fetch, sleep: async () => {} });
    expect(code).toBe(2);
    expect(out).toContain('harness watch');
    expect(out).toContain('harness detect');
  });
});
