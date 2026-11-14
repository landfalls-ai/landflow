/**
 * The landflow-brain client (docs/landflow-brain-mod.md): `postWork`, `getBriefing` and the offline queue. The queue's
 * rules are pure functions; the two calls take the engine's `$` and reach Landflow only with the key from userConfig, at
 * an `https:` URL or `http://localhost`.
 */
import type { EngineInterface } from 'claude-code'
import type { BrainWorkEvent } from './summary'

/** At most this many events wait, and none longer than this. */
export const QUEUE_MAX = 500
export const QUEUE_DAYS = 14
export const BACKOFF_FIRST_MS = 30_000
export const BACKOFF_MAX_MS = 30 * 60_000
export const BRIEFING_TIMEOUT_MS = 2000
/** POST /api/brain/work takes this many events at once. */
const BATCH = 50

export interface QueueItem {
  event: BrainWorkEvent
  /** When it was queued, ms. */
  at: number
}

export interface Queue {
  items: QueueItem[]
  /** Failures in a row; 0 after a success. */
  failures: number
  /** No send before this time, ms. */
  nextAt: number
  /** Set by a 401: nothing more is sent until the key changes. */
  stopped?: 'key'
  /** A hash of the key the 401 rejected (never the key); a different key lifts the stop. */
  stoppedFor?: string
}

/** A short hash of the key, to tell a changed key from the rejected one. Not a secret store: it only compares. */
export function keyFingerprint(key: string): string {
  let a = 0xdeadbeef
  let b = 0x41c6ce57
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i)
    a = Math.imul(a ^ c, 2654435761)
    b = Math.imul(b ^ c, 1597334677)
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909)
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909)
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36)
}

/** The queue with a 401's stop lifted when the configured key is not the one that was rejected. */
export function liftStop(queue: Queue, fingerprint: string): Queue {
  if (!queue.stopped || queue.stoppedFor === fingerprint) return queue
  const { stopped: _s, stoppedFor: _f, ...rest } = queue
  return { ...rest, nextAt: 0 }
}

export const emptyQueue = (): Queue => ({ items: [], failures: 0, nextAt: 0 })

/** The backoff after `failures` failures in a row: 30 s, doubling, at most 30 min. */
export const backoffMs = (failures: number): number => Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, failures - 1))

/** Queue an event (the same session again replaces its earlier one), then drop what is over 14 days and what is over 500, oldest first. */
export function enqueue(queue: Queue, event: BrainWorkEvent, now: number): Queue {
  const horizon = now - QUEUE_DAYS * 86_400_000
  const items = [...queue.items.filter(item => item.event.sourceId !== event.sourceId), { event, at: now }].filter(item => item.at >= horizon)
  return { ...queue, items: items.slice(-QUEUE_MAX) }
}

/** What goes out now, at most 50: nothing while stopped or backing off. */
export function due(queue: Queue, now: number): QueueItem[] {
  if (queue.stopped || now < queue.nextAt) return []
  return queue.items.slice(0, BATCH)
}

/** After a request (the batch is matched by session and queue time, so an event queued meanwhile stays): 2xx drops the batch; 401 stops; anything else keeps the batch and backs off. */
export function settle(queue: Queue, batch: readonly QueueItem[], status: number | undefined, now: number, fingerprint?: string): Queue {
  if (status === 401) return { ...queue, stopped: 'key', ...(fingerprint && { stoppedFor: fingerprint }) }
  if (status !== undefined && ((status >= 200 && status < 300) || status === 400 || status === 413 || status === 422)) {
    // A refused batch (400 and the like) would be refused again: drop it rather than retry forever.
    return { ...queue, items: queue.items.filter(item => !batch.some(sent => sent.at === item.at && sent.event.sourceId === item.event.sourceId)), failures: 0, nextAt: 0 }
  }
  const failures = queue.failures + 1
  return { ...queue, failures, nextAt: now + backoffMs(failures) }
}

/** The server URL, only `https:` or `http://localhost` (also 127.0.0.1), without a trailing slash; else nothing. */
export function serverUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim().replace(/\/+$/, '')
  if (!/^https:\/\/[^\s/]+/i.test(text) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(text)) return undefined
  return text
}

export interface Config {
  url: string
  key: string
}

const headers = (config: Config) => ({ 'content-type': 'application/json', authorization: `Bearer ${config.key}` })

/** What POST /api/brain/work answered. `status` is undefined when Landflow could not be reached. */
export interface PostResult {
  status?: number
  saved: string[]
  rejected: Array<{ sourceId: string; reason: string }>
}

export async function postWork($: EngineInterface, config: Config, events: readonly BrainWorkEvent[]): Promise<PostResult> {
  try {
    const response = await $.http.fetch(`${config.url}/api/brain/work`, { method: 'POST', headers: headers(config), body: JSON.stringify({ events }) })
    let saved: string[] = []
    let rejected: PostResult['rejected'] = []
    try {
      const body = JSON.parse(response.text || '{}') as { saved?: Array<{ sourceId: string }>; rejected?: PostResult['rejected'] }
      saved = (body.saved ?? []).map(item => item.sourceId)
      rejected = body.rejected ?? []
    } catch {
      // Not JSON: the status says enough.
    }
    return { status: response.status, saved, rejected }
  } catch {
    return { saved: [], rejected: [] }
  }
}

/** DELETE /api/brain/work/:sourceId. 204 and 404 both mean it is gone. */
export async function deleteWork($: EngineInterface, config: Config, sourceId: string): Promise<number | undefined> {
  try {
    const response = await $.http.fetch(`${config.url}/api/brain/work/${encodeURIComponent(sourceId)}?source=claude-code`, { method: 'DELETE', headers: headers(config) })
    return response.status
  } catch {
    return undefined
  }
}

export interface BriefingItem {
  title: string
  repo?: string
  at?: string
}

export interface Briefing {
  day: string
  yesterday: BriefingItem[]
  autoSend: 'allowed' | 'forbidden'
  brain: 'on' | 'off'
}

const cacheKey = (day: string) => `briefing:${day}`

/**
 * The person's briefing for `day`, from Landflow within 2 s, else the cache of that day, else nothing. A fresh answer
 * is cached; older days' caches are dropped.
 */
export async function getBriefing($: EngineInterface, config: Config, day: string): Promise<Briefing | undefined> {
  const cached = async () => ((await $.store.get(cacheKey(day))) as Briefing | undefined) ?? undefined
  const fetched = (async (): Promise<Briefing | undefined> => {
    const response = await $.http.fetch(`${config.url}/api/brain/briefing?day=${day}`, { method: 'GET', headers: headers(config) })
    if (response.status < 200 || response.status >= 300) return undefined
    const body = JSON.parse(response.text || '{}') as { yesterday?: BriefingItem[]; autoSend?: string; brain?: string }
    const briefing: Briefing = {
      day,
      yesterday: (body.yesterday ?? []).slice(0, 50).map(item => ({ title: String(item.title ?? ''), ...(item.repo && { repo: String(item.repo) }), ...(item.at && { at: String(item.at) }) })),
      autoSend: body.autoSend === 'forbidden' ? 'forbidden' : 'allowed',
      brain: body.brain === 'off' ? 'off' : 'on',
    }
    for (const key of await $.store.keys()) if (key.startsWith('briefing:') && key !== cacheKey(day)) await $.store.delete(key)
    await $.store.set(cacheKey(day), briefing)
    return briefing
  })().catch(() => undefined)
  const timeout = $.clock.sleep(BRIEFING_TIMEOUT_MS).then(() => 'timeout' as const)
  const first = await Promise.race([fetched, timeout])
  if (first && first !== 'timeout') return first
  return cached()
}
