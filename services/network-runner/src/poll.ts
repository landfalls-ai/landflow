/**
 * The loop (D15, FR-2): the runner calls the host (`POST /api/runner/v1/poll`), which holds the request up to 25 s and
 * answers a queued call at once, or 204; the runner makes the call and posts its answer (`POST …/calls/:id`). The host
 * never connects to the runner: this is outbound HTTPS only. Calls run side by side up to the concurrency; a runner at
 * capacity keeps telling the host it is here (a poll with `max: 0`), so a long call is never mistaken for a lost
 * runner. A 401 means the token was revoked: the loop ends. Other failures back off from 1 s to 30 s.
 */
import { performCall } from './call';
import { VERSION, type RunnerConfig } from './config';
import type { Claimed, RunnerAnswer } from './types';

const DEFAULT_RETRY = [1_000, 2_000, 5_000, 10_000, 30_000];

export type LoopEnd = 'stopped' | 'revoked';

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

export async function runLoop(config: RunnerConfig, signal: AbortSignal, log: (line: string) => void): Promise<LoopEnd> {
  const retry = config.retryMs?.length ? config.retryMs : DEFAULT_RETRY;
  const idleMs = config.idleMs ?? 5_000;
  const endpoint = (path: string) => new URL(path, config.url);
  const post = (path: string, payload: unknown) =>
    fetch(endpoint(path), { method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal });
  const active = new Set<Promise<void>>();
  let failures = 0;
  let revoked = false;

  const answer = async (id: string, result: RunnerAnswer) => {
    for (let attempt = 0; attempt < 4 && !signal.aborted; attempt++) {
      try {
        const response = await post(`/api/runner/v1/calls/${encodeURIComponent(id)}`, result);
        if (response.status === 401) revoked = true;
        if (response.ok || response.status === 401 || response.status === 404) return;
      } catch {
        // Try again below.
      }
      await sleep(retry[Math.min(attempt, retry.length - 1)], signal);
    }
    log(`call ${id} answer not delivered`);
  };

  const handle = (claimed: Claimed) => {
    const work = performCall({ ...claimed.request, id: claimed.id }, config, log)
      .then((result) => answer(claimed.id, result))
      .finally(() => active.delete(work));
    active.add(work);
  };

  while (!signal.aborted && !revoked) {
    const free = config.concurrency - active.size;
    try {
      const response = await post('/api/runner/v1/poll', { name: config.name, version: VERSION, max: Math.max(0, Math.min(free, 1)) });
      if (response.status === 401) {
        log('This runner’s token was revoked: stopping.');
        revoked = true;
        break;
      }
      if (!response.ok && response.status !== 204) throw new Error(`The host answered ${response.status}`);
      failures = 0;
      if (response.status === 200) handle((await response.json()) as Claimed);
      // At capacity the host answers at once (nothing to claim): wait for a call to end, or for the next heartbeat.
      else if (free <= 0) await Promise.race([sleep(idleMs, signal), ...active]);
    } catch (error) {
      if (signal.aborted) break;
      const wait = retry[Math.min(failures++, retry.length - 1)];
      log(`The host is not answering (${error instanceof Error ? error.message : 'error'}); trying again in ${Math.round(wait / 1000)} s`);
      await sleep(wait, signal);
    }
  }
  // Let calls in flight say what they got, unless the token is gone.
  if (!revoked) await Promise.allSettled([...active]);
  return revoked ? 'revoked' : 'stopped';
}
