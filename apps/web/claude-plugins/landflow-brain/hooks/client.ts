/**
 * The landflow-brain client (docs/landflow-brain-mod.md): `postWork`, `getBriefing` and the offline queue. The queue's
 * rules are pure functions; the two calls take the engine's `$` and reach Landflow only with the key from userConfig, at
 * an `https:` URL or `http://localhost`.
 */
import type { EngineInterface } from 'claude-code'
import { clip, cleanText, safeLink } from './journal'
import { parseProjectContext, projectQuery, type ProjectContext } from './project'
import type { BrainWorkEvent } from './summary'

/** Who may read an item: the person alone (the default), the people they share a project with, or the organization. */
export type WorkVisibility = 'private' | 'team' | 'org'
export const VISIBILITIES: readonly WorkVisibility[] = ['private', 'team', 'org']
/** A work event as sent: `toEvent`'s, with the visibility the person picked. */
export type OutEvent = Omit<BrainWorkEvent, 'visibility'> & { visibility: WorkVisibility }

/** At most this many events wait, and none longer than this. */
export const QUEUE_MAX = 500
export const QUEUE_DAYS = 14
export const BACKOFF_FIRST_MS = 30_000
export const BACKOFF_MAX_MS = 30 * 60_000
export const BRIEFING_TIMEOUT_MS = 2000
/** A POST or DELETE that has not answered by now counts as unreachable. */
export const REQUEST_TIMEOUT_MS = 10_000

/** `promise`, or `fallback` when the clock passes `ms` first. */
async function within<T>($: EngineInterface, promise: Promise<T>, fallback: T, ms = REQUEST_TIMEOUT_MS): Promise<T> {
  const timeout = $.clock.sleep(ms).then(() => fallback)
  return Promise.race([promise, timeout])
}
/** POST /api/brain/work takes this many events at once. */
const BATCH = 50

export interface QueueItem {
  event: OutEvent
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
export function enqueue(queue: Queue, event: OutEvent, now: number): Queue {
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

export function postWork($: EngineInterface, config: Config, events: readonly OutEvent[]): Promise<PostResult> {
  return within($, postOnce($, config, events), { saved: [], rejected: [] })
}

async function postOnce($: EngineInterface, config: Config, events: readonly OutEvent[]): Promise<PostResult> {
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
export function deleteWork($: EngineInterface, config: Config, sourceId: string): Promise<number | undefined> {
  return within($, deleteOnce($, config, sourceId), undefined)
}

async function deleteOnce($: EngineInterface, config: Config, sourceId: string): Promise<number | undefined> {
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
  sourceId?: string
  source?: string
  visibility?: WorkVisibility
  /** Only a link to the configured Landflow or github.com survives. */
  url?: string
}

export interface RelatedPerson {
  name: string
  because: { type: 'repo' | 'initiative' | 'customer' | 'area' | 'similar'; name: string }
  items: BriefingItem[]
}

export interface Briefing {
  day: string
  today: BriefingItem[]
  yesterday: BriefingItem[]
  related: RelatedPerson[]
  autoSend: 'allowed' | 'forbidden'
  brain: 'on' | 'off'
}

const cacheKey = (day: string) => `briefing:${day}`
const BECAUSE = ['repo', 'initiative', 'customer', 'area', 'similar']

/** One item from the server, as data: clipped, one line, its link kept only when it is safe. Nothing from the server is trusted. */
export function cleanItem(raw: unknown, baseUrl: string): BriefingItem {
  const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const text = (value: unknown, max: number) => (typeof value === 'string' && value ? cleanText(value, max, baseUrl) || undefined : undefined)
  // Ids are sent back to the brain (Post as my update), never drawn: one clipped line, with any link in them kept, or the post would miss.
  const id = (value: unknown, max: number) => (typeof value === 'string' && value ? clip(value, max) || undefined : undefined)
  const url = typeof item.url === 'string' ? safeLink(item.url, baseUrl) : undefined
  const visibility = VISIBILITIES.find(v => v === item.visibility)
  return {
    title: text(item.title, 160) ?? '',
    ...(text(item.repo, 80) && { repo: text(item.repo, 80) }),
    ...(text(item.at, 40) && { at: text(item.at, 40) }),
    ...(id(item.sourceId, 120) && { sourceId: id(item.sourceId, 120) }),
    ...(id(item.source, 40) && { source: id(item.source, 40) }),
    ...(visibility && { visibility }),
    ...(url && { url }),
  }
}

/** The related colleagues from the server: at most 5 people, 3 items each, names and reasons clipped. */
export function cleanRelated(raw: unknown, baseUrl: string): RelatedPerson[] {
  if (!Array.isArray(raw)) return []
  const out: RelatedPerson[] = []
  for (const entry of raw.slice(0, 5)) {
    const row = (entry ?? {}) as { person?: { name?: unknown }; because?: { type?: unknown; name?: unknown }; items?: unknown }
    const name = typeof row.person?.name === 'string' ? cleanText(row.person.name, 40, baseUrl) : ''
    if (!name) continue
    const type = BECAUSE.includes(String(row.because?.type)) ? (row.because?.type as RelatedPerson['because']['type']) : 'similar'
    out.push({ name, because: { type, name: cleanText(typeof row.because?.name === 'string' ? row.because.name : '', 60, baseUrl) }, items: (Array.isArray(row.items) ? row.items : []).slice(0, 3).map(item => cleanItem(item, baseUrl)).filter(item => item.title) })
  }
  return out
}

/**
 * The person's briefing for `day`, from Landflow within 2 s, else the cache of that day, else nothing. A fresh answer
 * is cached; older days' caches are dropped.
 */
export async function getBriefing($: EngineInterface, config: Config, day: string): Promise<Briefing | undefined> {
  const cached = async () => ((await $.store.get(cacheKey(day))) as Briefing | undefined) ?? undefined
  const fetched = (async (): Promise<Briefing | undefined> => {
    const response = await $.http.fetch(`${config.url}/api/brain/briefing?day=${day}`, { method: 'GET', headers: headers(config) })
    if (response.status < 200 || response.status >= 300) return undefined
    const body = JSON.parse(response.text || '{}') as { today?: unknown[]; yesterday?: unknown[]; related?: unknown; autoSend?: string; brain?: string }
    const list = (value: unknown[] | undefined) => (value ?? []).slice(0, 50).map(item => cleanItem(item, config.url))
    const briefing: Briefing = {
      day,
      today: list(body.today),
      yesterday: list(body.yesterday),
      related: cleanRelated(body.related, config.url),
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
  const old = await cached()
  return old && { ...old, today: old.today ?? [], related: old.related ?? [] }
}

/** The project context of a repository: GET /api/projects/context. No project is undefined; any failure (unreachable, refused, not JSON, too slow) is 'failed'. */
export function getProjectContext($: EngineInterface, config: Config, repo: string): Promise<ProjectContext | undefined | 'failed'> {
  const run = async (): Promise<ProjectContext | undefined | 'failed'> => {
    try {
      const response = await $.http.fetch(`${config.url}/api/projects/context?${projectQuery(repo)}`, { method: 'GET', headers: headers(config) })
      if (response.status < 200 || response.status >= 300) return 'failed'
      return parseProjectContext(JSON.parse(response.text || '{}'))
    } catch {
      return 'failed'
    }
  }
  return within($, run(), 'failed' as const, BRIEFING_TIMEOUT_MS)
}

/** The request that changes who reads an item the person sent: PATCH /api/brain/work/:sourceId. */
export function visibilityRequest(sourceId: string, visibility: WorkVisibility, source = 'claude-code') {
  return { method: 'PATCH' as const, path: `/api/brain/work/${encodeURIComponent(sourceId)}?source=${source}`, body: { visibility } }
}

/** The request for "Post as my update": POST /api/brain/work/:sourceId/share. Only `team` or `org`; never `private`. */
export function shareRequest(sourceId: string, visibility: 'team' | 'org' = 'org', source = 'claude-code') {
  // An empty source leaves it out: the brain then looks the item up by its id alone.
  return { method: 'POST' as const, path: `/api/brain/work/${encodeURIComponent(sourceId)}/share${source ? `?source=${encodeURIComponent(source)}` : ''}`, body: { visibility } }
}

type Request = { method: string; path: string; body: unknown }

/** Send one of the requests above; the status, or undefined when Landflow could not be reached. */
export function callBrain($: EngineInterface, config: Config, request: Request): Promise<number | undefined> {
  const run = async () => {
    try {
      const response = await $.http.fetch(`${config.url}${request.path}`, { method: request.method, headers: headers(config), body: JSON.stringify(request.body) })
      return response.status
    } catch {
      return undefined
    }
  }
  return within($, run(), undefined)
}

export type PostOutcome = 'posted' | 'cancelled' | 'failed' | 'unreachable' | 'not-found'

/**
 * Post as my update, after a confirm. `ask` is the question to the person; anything but one of the two Post answers
 * (a Cancel, an error, no one to ask) sends nothing.
 */
export async function confirmAndPost(ask: (question: string, options: string[]) => Promise<string>, call: (visibility: 'team' | 'org') => Promise<number | undefined>, title: string): Promise<PostOutcome> {
  let answer: string
  try {
    answer = await ask(`Post "${clip(title, 100)}" as your update? Colleagues will read this title and summary.`, ['Post to org', 'Post to team', 'Cancel'])
  } catch {
    return 'cancelled'
  }
  if (answer !== 'Post to org' && answer !== 'Post to team') return 'cancelled'
  const status = await call(answer === 'Post to team' ? 'team' : 'org')
  if (status === undefined) return 'unreachable'
  if (status === 404) return 'not-found'
  return status >= 200 && status < 300 ? 'posted' : 'failed'
}
