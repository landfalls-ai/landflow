/** sseResponse (bounded buffers, ids, heartbeats), the bus replay ring and the /api/events stream (replay, reset, revocation). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bus, REPLAY_RING_SIZE } from '@/lib/server/bus';
import { eventStream } from '@/lib/server/events-stream';
import { sseResponse } from '@/lib/server/sse';

const decoder = new TextDecoder();
const reqWith = (abort: AbortController, headers: Record<string, string> = {}) => new Request('http://x/api/events', { headers, signal: abort.signal });

/** Read chunks until `done` says enough, or `ms` pass. */
async function readUntil(response: Response, enough: (text: string) => boolean, ms = 500) {
  const reader = response.body!.getReader();
  let text = '';
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !enough(text)) {
    const race = await Promise.race([reader.read(), new Promise<undefined>((r) => setTimeout(r, 50))]);
    if (race === undefined) continue;
    if (race.done) break;
    text += decoder.decode(race.value);
  }
  reader.releaseLock();
  return text;
}

const registry = (n: number) => ({ channel: 'registry', event: { type: 'test', n } }) as never;
const execution = (workflowId: string) => ({ channel: 'execution', workflowId, event: { type: 'x' } }) as never;

afterEach(() => vi.useRealTimers());

describe('sseResponse', () => {
  it('writes id and event lines and splits multi-line data', async () => {
    const abort = new AbortController();
    const response = sseResponse(
      reqWith(abort),
      (send, close) => {
        send({ a: 1 }, { id: 7, event: 'thing' });
        send('l1\nl2');
        close();
      },
      { heartbeatMs: 0 },
    );
    const text = await readUntil(response, () => false, 200);
    expect(text).toContain('id: 7\nevent: thing\ndata: {"a":1}\n\n');
    expect(text).toContain('data: l1\ndata: l2\n\n');
  });

  it('closes a stalled reader at the buffer limit and runs the cleanup once', async () => {
    const abort = new AbortController();
    const cleanup = vi.fn();
    let sent = 0;
    let last = true;
    const response = sseResponse(
      reqWith(abort),
      (send) => {
        // Nothing reads: 100 events of ~100 bytes against a 1 KiB limit.
        for (let i = 0; i < 100 && last; i++, sent++) last = send('x'.repeat(100));
        return cleanup;
      },
      { maxBufferedBytes: 1024, heartbeatMs: 0 },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(last).toBe(false);
    expect(sent).toBeLessThan(15);
    expect(cleanup).toHaveBeenCalledTimes(1);
    const text = await readUntil(response, () => false, 100);
    expect(text).toContain('buffer limit reached');
  });

  it('cleans up on abort and on cancel, and sends heartbeats', async () => {
    const abort = new AbortController();
    const cleanup = vi.fn();
    const response = sseResponse(reqWith(abort), () => cleanup, { heartbeatMs: 10 });
    const text = await readUntil(response, (t) => t.includes(': ping'), 300);
    expect(text).toContain(': ping');
    abort.abort();
    await new Promise((r) => setTimeout(r, 10));
    expect(cleanup).toHaveBeenCalledTimes(1);

    const other = sseResponse(reqWith(new AbortController()), () => cleanup, { heartbeatMs: 0 });
    await new Promise((r) => setTimeout(r, 10));
    await other.body!.cancel();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
});

describe('bus replay', () => {
  it('keeps the last events and replays those after a seq', () => {
    const seen: number[] = [];
    bus.publish(registry(1));
    let first = 0;
    const stop = bus.subscribe((e) => (first ||= e.seq));
    bus.publish(registry(2));
    stop();
    const stop2 = bus.subscribe((e) => seen.push(e.seq), { afterSeq: first - 1 });
    stop2();
    expect(seen).toContain(first);
    expect(bus.covers(first)).toBe(true);
    for (let i = 0; i < REPLAY_RING_SIZE + 5; i++) bus.publish(registry(i));
    expect(bus.covers(first)).toBe(false);
  });
});

describe('/api/events stream', () => {
  const all = () => () => true;

  it('numbers events with id: <boot>.<seq>', async () => {
    const abort = new AbortController();
    const response = eventStream(reqWith(abort), { authorize: () => all(), heartbeatMs: 0 });
    await new Promise((r) => setTimeout(r, 10));
    bus.publish(registry(1));
    const text = await readUntil(response, (t) => t.includes('"n":1'));
    abort.abort();
    expect(text).toMatch(new RegExp(`id: ${bus.bootId}\\.\\d+\\ndata: .*"n":1`));
  });

  it('replays events after Last-Event-ID, filtered', async () => {
    bus.publish(registry(100));
    const mark = new Request('http://x').headers; // keep lint quiet about unused helpers
    void mark;
    let seq = 0;
    const stop = bus.subscribe((e) => (seq = e.seq));
    bus.publish(registry(101));
    bus.publish(execution('hidden'));
    bus.publish(registry(102));
    stop();
    const abort = new AbortController();
    const response = eventStream(reqWith(abort, { 'last-event-id': `${bus.bootId}.${seq - 3}` }), {
      authorize: () => (event) => !('workflowId' in event && event.workflowId === 'hidden'),
      heartbeatMs: 0,
    });
    const text = await readUntil(response, (t) => t.includes('"n":102'));
    abort.abort();
    expect(text).toContain('"n":101');
    expect(text).toContain('"n":102');
    expect(text).not.toContain('hidden');
    expect(text).not.toContain('event: reset');
  });

  it('sends reset when the id is out of range or from another process', async () => {
    const oldSeq = (() => {
      let s = 0;
      const stop = bus.subscribe((e) => (s = e.seq));
      bus.publish(registry(1));
      stop();
      return s;
    })();
    for (let i = 0; i < REPLAY_RING_SIZE + 5; i++) bus.publish(registry(i));
    for (const id of [`${bus.bootId}.${oldSeq}`, 'zzzzzz.5', 'garbage']) {
      const abort = new AbortController();
      const response = eventStream(reqWith(abort, { 'last-event-id': id }), { authorize: () => all(), heartbeatMs: 0 });
      const text = await readUntil(response, (t) => t.includes('event: reset'), 300);
      abort.abort();
      expect(text).toContain('event: reset');
    }
  });

  it('stops a revoked project’s events within the interval and closes when the user is gone', async () => {
    let revoked = false;
    let gone = false;
    const abort = new AbortController();
    const cleanupSpy = vi.fn();
    const response = eventStream(reqWith(abort), {
      revalidateMs: 20,
      heartbeatMs: 0,
      authorize: () => {
        if (gone) return undefined;
        return (event) => !(revoked && 'workflowId' in event && event.workflowId === 'wf_a');
      },
    });
    const reader = response.body!.getReader();
    bus.publish(execution('wf_a'));
    const first = decoder.decode((await reader.read()).value);
    void first;
    revoked = true;
    await new Promise((r) => setTimeout(r, 60));
    bus.publish(execution('wf_a'));
    bus.publish(registry(555));
    let text = '';
    const deadline = Date.now() + 300;
    while (!text.includes('"n":555') && Date.now() < deadline) {
      const r = await Promise.race([reader.read(), new Promise<undefined>((res) => setTimeout(res, 50))]);
      if (r && !r.done) text += decoder.decode(r.value);
    }
    expect(text).toContain('"n":555');
    expect(text).not.toContain('wf_a');
    gone = true;
    await new Promise((r) => setTimeout(r, 60));
    let ended = false;
    for (let i = 0; i < 10 && !ended; i++) {
      const r = await Promise.race([reader.read(), new Promise<undefined>((res) => setTimeout(res, 50))]);
      ended = r?.done === true;
    }
    expect(ended).toBe(true);
    void cleanupSpy;
    abort.abort();
  });
});
