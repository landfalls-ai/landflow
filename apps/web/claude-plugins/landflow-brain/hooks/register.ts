/**
 * landflow-brain (docs/landflow-brain-mod.md): your own Claude Code work in the company brain.
 *
 * It watches a session in an allowed repository and keeps a local journal entry: counts, directories, commits, pull
 * requests and a title made on this machine from the first prompt. At the end the entry is held for your review (mode
 * `auto` queues it instead, unless your admin forbids sending on its own). `/brain review` sends it as a private
 * `work.session`. At the next session start your own yesterday comes back into the system prompt, within 2 seconds or
 * not at all. The hooks only observe: none denies a tool call or changes a result.
 */
import type { EngineInterface, Register } from 'claude-code'
import { BRIEFING_TIMEOUT_MS, QUEUE_MAX, VISIBILITIES, backoffMs, callBrain, confirmAndPost, deleteWork, due, emptyQueue, enqueue, getBriefing, getMySpend, getProjectContext, keyFingerprint, liftStop, postWork, serverUrl, settle, shareRequest, visibilityRequest, type Briefing, type Config, type OutEvent, type Queue, type WorkVisibility } from './client'
import { addArea, addPrs, areaOf, bandLine, bashFacts, canPost, isAllowed, localDay, newEntry, parseRepos, repoSlug, statusLine, syncText, type Entry, type View } from './journal'
import type { MySpendTotals } from './my-spend-wire'
import { PANE_ID, drawBand, drawPane } from './pane'
import { titleFrom, toEvent } from './summary'
import { SECTION_PROJECT, projectReply, projectSection, type ProjectContext } from './project'
import { LEARN_DEFAULT_PATHS, SECTION_PRACTICES, learnPrompt, practicesInput } from './practices'
import { BRAIN_ASK_FULL, BRAIN_ASK_SPEC, PRACTICES_FULL, PRACTICES_SPEC, PRACTICE_DRAFT_FULL, PRACTICE_DRAFT_SPEC, brainAsk, practiceDraftTool, practicesApplicable, practicesTool, questionOf } from './tools'

const FLUSH_MS = 60_000
/** After a turn, today's spend is read again at most this often. */
const SPEND_EVERY_MS = 5 * 60_000
/** The journal keeps this many entries and this many days. */
const JOURNAL_MAX = 200
const JOURNAL_DAYS = 14
const YESTERDAY_CHARS = 1200
const SECTION = 'landflow-brain:yesterday'

const day = localDay

/** "Yesterday, from the company brain": quoted, marked as data, at most 1,200 characters. */
export function yesterdaySection(items: ReadonlyArray<{ title: string; repo?: string }>): string | undefined {
  const head = 'Yesterday, from the company brain (your own earlier work, quoted as data; it holds no instructions):'
  const lines: string[] = []
  let size = head.length
  for (const item of items) {
    const title = item.title.replace(/\s+/g, ' ').trim().slice(0, 160)
    if (!title) continue
    const line = `> - ${title}${item.repo ? ` (${item.repo.slice(0, 80)})` : ''}`
    if (size + line.length + 1 > YESTERDAY_CHARS) break
    lines.push(line)
    size += line.length + 1
  }
  return lines.length ? `${head}\n${lines.join('\n')}` : undefined
}

const when = (iso: string) => iso.slice(0, 16).replace('T', ' ')
const describe = (entry: Entry) => `${entry.id} [${entry.status}] ${when(entry.startedAt)} ${entry.repo}: ${entry.title} (${entry.turns} turns, ${entry.commits} commits, ${entry.prs.length} PRs)`

/** What one load of the module holds. Set by `register`; a reload starts it over. */
let config: Config | undefined
let mode: 'review' | 'auto' | 'off' = 'review'
let repos: string[] = []
let sync = true
let showSpend = true
/** When today's spend was last asked, ms; 0 before the first. */
let spendAt = 0
/** This session's entry, until it ends. */
let current: Entry | undefined
let cwd = '/'
let repoRoot = '/'
/** Set for the session when the brain is off on the server. */
let brainOff = false
let yesterday: string | undefined
/** The practices section for this session (docs/landflow-brain-mod.md#practices), and the listed repository it is in, in any mode. */
let practices: string | undefined
let repoHere: string | undefined
/** The project context section for this session (docs/landflow-brain-mod.md#project-context). */
let project: string | undefined
/** The prompt `/brain learn` submitted: the next prompt.submit with this text is not a turn of the person's. */
let ownPrompt: string | undefined
let flushing: Promise<void> | undefined
/** The sessions whose events are in a POST that has not been settled yet. */
const inFlight = new Set<string>()
/** The allowed repository this session is in, while it can still be recorded. */
let allowed: { repo: string; branch?: string } | undefined
let fingerprint = ''
let seq = 0

async function load($: EngineInterface): Promise<Entry[]> {
  return (((await $.store.get('journal')) as Entry[] | undefined) ?? []).filter(Boolean)
}

/** Every journal and queue write runs one after another, so no load-modify-save interleaves with another. */
let lock: Promise<unknown> = Promise.resolve()
function withJournal<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn)
  lock = run.catch(() => undefined)
  return run
}

/** An entry waiting for its delete in the brain is kept past the horizon and the count: its delete must be answered. */
async function save($: EngineInterface, journal: Entry[]) {
  const horizon = (await $.clock.now()) - JOURNAL_DAYS * 86_400_000
  const live = journal.filter(entry => entry.status !== 'dropped' && entry.status !== 'forgetting' && Date.parse(entry.startedAt) >= horizon).slice(-JOURNAL_MAX)
  const keep = new Set(live)
  await $.store.set('journal', journal.filter(entry => entry.status === 'forgetting' || keep.has(entry)))
}

const upsert = ($: EngineInterface, entry: Entry) =>
  withJournal(async () => {
    const journal = await load($)
    const at = journal.findIndex(item => item.id === entry.id)
    if (at >= 0) journal[at] = entry
    else journal.push(entry)
    await save($, journal)
  })

async function queueOf($: EngineInterface): Promise<Queue> {
  return ((await $.store.get('queue')) as Queue | undefined) ?? emptyQueue()
}

/** An entry's id and session id: the clock's millisecond, and a count so two in one millisecond differ. */
async function openEntry($: EngineInterface, repo: string, branch?: string) {
  const now = await $.clock.now()
  const tag = `${now.toString(36)}${(seq++).toString(36)}`
  current = newEntry({ id: `e-${tag}`, sourceId: `cc-${tag}`, repo, ...(branch && { branch }), now })
  await upsert($, current)
}

/** End the running entry: held for review (dropped when it has no turn); in mode `auto` queued, unless the admin forbids it or nothing is known of the policy. */
async function closeCurrent($: EngineInterface, sessionId: string | undefined, canSend: boolean) {
  const entry = current
  if (!entry) return
  current = undefined
  entry.endedAt = new Date(await $.clock.now()).toISOString()
  if (sessionId) entry.sourceId = sessionId
  if (!entry.turns) {
    entry.status = 'dropped'
    await upsert($, entry)
    return
  }
  entry.status = 'held'
  await upsert($, entry)
  // Only a briefing that said `allowed` lets mode `auto` send; an unknown policy holds.
  const policy = (await $.store.get('autoSend')) === 'allowed'
  if (canSend && mode === 'auto' && policy && !(await paused($))) await send($, entry)
}

async function paused($: EngineInterface): Promise<boolean> {
  return brainOff || (await $.store.get('paused')) === true
}

async function showStatus($: EngineInterface) {
  if (!config || mode === 'off') return $.ui.status(undefined)
  const queue = await queueOf($)
  if (queue.stopped === 'key') return $.ui.status('brain: key rejected')
  if (await paused($)) return $.ui.status('brain: paused')
  const held = (await load($)).filter(entry => entry.status === 'held').length
  const spend = showSpend ? ((await $.store.get('spend')) as StoredSpend | undefined) : undefined
  $.ui.status(statusLine(mode, await $.store.get('autoSend'), held, spend && spend.day === day(await $.clock.now()) ? spend.totals : undefined))
}

interface StoredSpend {
  /** The day the totals are for (the mod's local day, since the wire carries no day; near midnight it can differ from the instance's). */
  day: string
  totals: MySpendTotals
}

/** Asks for today's spend and keeps it with its day; a failed call keeps the last value of the same day, and an older day's goes. Never throws. */
async function refreshSpend($: EngineInterface): Promise<void> {
  if (!config || !showSpend || mode === 'off') return
  try {
    const now = await $.clock.now()
    spendAt = now
    const totals = await getMySpend($, config)
    const today = day(now)
    const old = (await $.store.get('spend')) as StoredSpend | undefined
    if (totals) await $.store.set('spend', { day: today, totals } satisfies StoredSpend)
    else if (old && old.day !== today) await $.store.delete('spend')
  } catch {
    // The status line goes without it.
  }
}

/** The stored view, only while it is today's: an earlier day's view (an offline start, a session past midnight) counts as none. */
async function storedView($: EngineInterface): Promise<View | undefined> {
  const stored = (await $.store.get('view')) as View | undefined
  return stored && stored.day === day(await $.clock.now()) ? stored : undefined
}

/** The briefing's parts the pane, /brain sync and the band draw; kept for the day. */
async function viewOf($: EngineInterface, fresh: boolean): Promise<View | undefined> {
  if (!config) return undefined
  if (!fresh) {
    const stored = await storedView($)
    if (stored) return stored
  }
  const briefing = await getBriefing($, config, day(await $.clock.now()))
  if (!briefing) return storedView($)
  const view: View = { day: briefing.day, today: briefing.today, yesterday: briefing.yesterday, related: briefing.related }
  await $.store.set('view', view)
  await $.store.set('autoSend', briefing.autoSend)
  return view
}

/** Post as my update, after a confirm: the answer in words. */
async function postUpdate($: EngineInterface, sourceId: string, title: string, source = ''): Promise<string> {
  if (!config) return 'not set up'
  const cfg = config
  const outcome = await confirmAndPost(
    (question, options) => $.ui.ask(question, options),
    visibility => callBrain($, cfg, shareRequest(sourceId, visibility, source)),
    title,
  )
  return { posted: 'Posted as your update. The item itself keeps its own visibility.', cancelled: 'Cancelled; nothing was posted.', failed: 'The brain refused it; nothing was posted.', unreachable: 'The brain could not be reached; nothing was posted.', 'not-found': 'The brain has no such item of yours; nothing was posted.' }[outcome]
}

/** Send what is due. One at a time; a failure backs off. Entries whose events were saved become `sent`. */
function flush($: EngineInterface): Promise<void> {
  if (flushing) return flushing
  flushing = flushOnce($)
    .catch(() => undefined)
    .finally(() => {
      flushing = undefined
    })
  return flushing
}

/** Retry the deletes of entries forgotten while the brain could not be reached. */
async function retryForgets($: EngineInterface) {
  if (!config) return
  const waiting = (await load($)).filter(entry => entry.status === 'forgetting')
  const gone = new Set<string>()
  for (const entry of waiting) {
    const status = await deleteWork($, config, entry.sourceId)
    if (status === 204 || status === 404) gone.add(entry.id)
  }
  if (!gone.size) return
  await withJournal(async () => {
    const fresh = await load($)
    for (const entry of fresh) if (gone.has(entry.id)) entry.status = 'dropped'
    await save($, fresh)
  })
}

async function flushOnce($: EngineInterface) {
  if (!config) return
  const now = await $.clock.now()
  const stopped = (await queueOf($)).stopped
  if (!stopped) await retryForgets($)
  if (await paused($)) return
  const batch = due(await queueOf($), now)
  if (!batch.length) return
  for (const item of batch) inFlight.add(item.event.sourceId)
  let status: number | undefined
  try {
    const result = await postWork($, config, batch.map(item => item.event))
    // Read the queue again: a send that came in during the request is kept, and only this batch leaves.
    status = result.status
    await withJournal(async () => {
      for (const item of batch) inFlight.delete(item.event.sourceId)
      await $.store.set('queue', settle(await queueOf($), batch, status, now, fingerprint))
      if (status !== undefined && status >= 200 && status < 300) await markSent($, batch, result, now)
      // In the same lock as markSent, so the two writers of `problems` cannot interleave.
      else if (status === 400 || status === 413 || status === 422) {
        await $.store.set('problems', [`the brain refused ${batch.length} event${batch.length === 1 ? '' : 's'} (HTTP ${status}); they stay held here and are not retried`])
      }
    })
  } finally {
    for (const item of batch) inFlight.delete(item.event.sourceId)
  }
}

/** Inside the journal lock: the entries whose events the brain saved become `sent`. */
async function markSent($: EngineInterface, batch: ReturnType<typeof due>, result: Awaited<ReturnType<typeof postWork>>, now: number) {
  await $.store.set('problems', result.rejected.map(item => `${item.sourceId}: ${item.reason}`.slice(0, 200)).slice(0, 10))
  const journal = await load($)
  const sent = new Set(result.saved)
  const marked: Entry[] = []
  for (const entry of journal) {
    if (entry.status === 'held' && sent.has(entry.sourceId)) {
      entry.status = 'sent'
      entry.sentAt = new Date(now).toISOString()
      const event = batch.find(item => item.event.sourceId === entry.sourceId)?.event
      if (event) entry.sentEvent = event
      marked.push(entry)
    }
  }
  // The same session sent again (a resumed one) replaced the earlier event there; it is one entry here too.
  for (const entry of journal) if (entry.status === 'sent' && !marked.includes(entry) && marked.some(item => item.sourceId === entry.sourceId)) entry.status = 'dropped'
  await save($, journal)
}

/**
 * Take an entry out (`/brain forget`, review's Drop): its event leaves the queue, and the journal and the queue are read
 * in one lock, so a flush cannot mark it sent in between. An entry the brain may hold (sent, or in a POST not answered
 * yet) becomes `forgetting` and is deleted there; any other is dropped. `deleted` is the DELETE's status.
 */
async function takeOut($: EngineInterface, entry: Entry): Promise<{ wasSent: boolean; deleted?: number }> {
  const { wasSent, posting } = await withJournal(async () => {
    const queue = await queueOf($)
    if (queue.items.some(item => item.event.sourceId === entry.sourceId)) await $.store.set('queue', { ...queue, items: queue.items.filter(item => item.event.sourceId !== entry.sourceId) })
    const journal = await load($)
    const at = journal.findIndex(item => item.id === entry.id)
    const stored = at >= 0 ? journal[at]! : entry
    const posting = inFlight.has(entry.sourceId)
    const wasSent = stored.status === 'sent' || stored.status === 'forgetting' || posting
    const next: Entry = { ...stored, status: wasSent ? 'forgetting' : 'dropped' }
    if (at >= 0) journal[at] = next
    else journal.push(next)
    await save($, journal)
    return { wasSent, posting }
  })
  if (!wasSent || !config) return { wasSent }
  // A POST still out is answered first, so the delete cannot reach the brain before the event it deletes.
  if (posting) await flushing?.catch(() => undefined)
  const deleted = await deleteWork($, config, entry.sourceId)
  if (deleted === 204 || deleted === 404) {
    await withJournal(async () => {
      const fresh = await load($)
      for (const item of fresh) if (item.id === entry.id) item.status = 'dropped'
      await save($, fresh)
    })
  }
  return { wasSent, deleted }
}

async function send($: EngineInterface, entry: Entry) {
  const now = await $.clock.now()
  await withJournal(async () => $.store.set('queue', enqueue(await queueOf($), { ...toEvent(entry), visibility: entry.visibility ?? 'private' } as OutEvent, now)))
  await flush($)
}

async function gitOut($: EngineInterface, argv: string[]): Promise<string | undefined> {
  try {
    const result = await $.process.run(argv, { cwd, timeoutMs: 1500 })
    return result.exitCode === 0 ? result.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

/** Set who reads an entry: here, in the queue while it waits, and with PATCH once the brain has it. */
async function setVisibility($: EngineInterface, entry: Entry, visibility: WorkVisibility): Promise<string> {
  await withJournal(async () => {
    const journal = await load($)
    const stored = journal.find(item => item.id === entry.id)
    if (stored) stored.visibility = visibility
    entry.visibility = visibility
    await save($, journal)
    const queue = await queueOf($)
    if (queue.items.some(item => item.event.sourceId === entry.sourceId)) await $.store.set('queue', { ...queue, items: queue.items.map(item => (item.event.sourceId === entry.sourceId ? { ...item, event: { ...item.event, visibility } } : item)) })
  })
  // A POST still out left with the old value: wait for it, then change the copy the brain holds.
  if (inFlight.has(entry.sourceId)) await flushing?.catch(() => undefined)
  const now = (await load($)).find(item => item.id === entry.id)
  if (now) entry.status = now.status
  if (entry.status !== 'sent' || !config) return `will be sent as ${visibility}.`
  const status = await callBrain($, config, visibilityRequest(entry.sourceId, visibility))
  if (status !== undefined && status >= 200 && status < 300) {
    // /brain status prints what went out: keep it current.
    await withJournal(async () => {
      const journal = await load($)
      const stored = journal.find(item => item.id === entry.id)
      if (stored?.sentEvent) stored.sentEvent = { ...stored.sentEvent, visibility }
      await save($, journal)
    })
    return `now ${visibility} in the brain.`
  }
  return status === undefined ? 'the brain could not be reached; nothing changed there.' : `the brain refused it (HTTP ${status}); nothing changed there.`
}

/** The repository of this checkout when the person listed it, from git alone (no host call). Sets `repoHere`. */
async function repoOf(gitFacts: Promise<Array<string | undefined>>): Promise<string | undefined> {
  const slug = repoSlug((await gitFacts)[0] ?? '')
  repoHere = isAllowed(repos, slug) ? slug : undefined
  return repoHere
}

/** The practices section for the session: within the one 2 s bound, or nothing. */
async function practicesSection($: EngineInterface, cfg: Config, repo: Promise<string | undefined>): Promise<string | undefined> {
  const run = async () => practicesApplicable($, cfg, { ...((await repo) && { repo: await repo }) })
  const bound = $.clock.sleep(BRIEFING_TIMEOUT_MS).then(() => undefined)
  return Promise.race([run().catch(() => undefined), bound])
}

/** The project context for the session, asked beside the practices once the repository is known, within the same 2 s bound. */
async function projectContext($: EngineInterface, cfg: Config, repo: Promise<string | undefined>): Promise<ProjectContext | undefined> {
  const run = async () => {
    const slug = await repo
    const found = slug ? await getProjectContext($, cfg, slug) : undefined
    return found === 'failed' ? undefined : found
  }
  const bound = $.clock.sleep(BRIEFING_TIMEOUT_MS).then(() => undefined)
  return Promise.race([run().catch(() => undefined), bound])
}

/** `/brain project`: which project this repository maps to. Reads again, so it is right after a project changes. */
async function projectCommand($: EngineInterface): Promise<string> {
  if (!config) return 'landflow-brain is not set up.'
  if (!repoHere) return projectReply(undefined, undefined)
  return projectReply(repoHere, await getProjectContext($, config, repoHere))
}

/** `/brain practices`: what applies here. */
async function practicesCommand($: EngineInterface): Promise<string> {
  if (!config) return 'landflow-brain is not set up.'
  return (await practicesTool($, config, {}, repoHere)).text
}

/** `/brain learn [paths]`: only in a listed repository; hands Claude a prompt that drafts practices from the checkout. */
async function learnCommand($: EngineInterface, paths: string[]): Promise<string> {
  if (!repoHere) return 'Learning reads this checkout, so the repository must be listed: add owner/name to the Repositories option of landflow-brain (and run this inside that repository).'
  const sha = await gitOut($, ['git', 'rev-parse', 'HEAD'])
  if (!sha || !/^[0-9a-f]{7,40}$/.test(sha)) return 'Could not read this repository\'s commit (git rev-parse HEAD).'
  const clean = paths.map(path => path.replace(/^\.?\//, '')).filter(path => path && !path.includes('..') && !path.startsWith('/')).slice(0, 20)
  const prompt = learnPrompt(repoHere, sha, clean)
  ownPrompt = prompt
  try {
    // Not awaited: the prompt is a turn of its own, once the session is idle, and this command must not wait on it.
    void Promise.resolve($.prompt.submit({ text: prompt } as never)).catch(() => {
      ownPrompt = undefined
    })
    return `Asked Claude to read ${clean.length ? clean.join(', ') : `${LEARN_DEFAULT_PATHS.join(', ')} and the configuration loaders`} at ${sha.slice(0, 7)} and draft practices. A person approves each draft on /brain → Practices.`
  } catch {
    ownPrompt = undefined
    return `This session cannot send a prompt on its own. Paste this to Claude:\n\n${prompt}`
  }
}

export const register: Register = (on, options) => {
  const url = serverUrl(options.url)
  const key = typeof options.key === 'string' ? options.key.trim() : ''
  repos = parseRepos(options.repos)
  mode = options.mode === 'auto' || options.mode === 'off' ? options.mode : 'review'
  sync = options.sync !== false
  showSpend = options.showSpend !== false
  spendAt = 0
  config = url && key ? { url, key } : undefined
  fingerprint = keyFingerprint(key)
  allowed = undefined
  current = undefined
  flushing = undefined
  inFlight.clear()
  lock = Promise.resolve()

  on('session.start', async ($, e, next) => {
    cwd = e.cwd || '/'
    repoRoot = cwd
    current = undefined
    allowed = undefined
    brainOff = false
    yesterday = undefined
    practices = undefined
    repoHere = undefined
    project = undefined
    // The model's own way in: only with a key, and never failing the session.
    if (config) for (const spec of [BRAIN_ASK_SPEC, PRACTICES_SPEC, PRACTICE_DRAFT_SPEC]) await $.tool.register(spec as never).catch(() => undefined)
    await $.command.register({ name: 'brain', description: 'Your work in the company brain: sync, today, review, status, pause, resume, forget <id>, visibility <id> private|team|org, post <id>; practices, learn [paths], project', argumentHint: 'sync | today | review | status | pause | resume | forget <id> | visibility <id> <who> | post <id> | practices | learn [paths] | project' })
    // Git runs beside the briefing and the practices, so one 2 s bound holds for all three.
    const gitFacts = Promise.all([gitOut($, ['git', 'remote', 'get-url', 'origin']), gitOut($, ['git', 'rev-parse', '--show-toplevel']), gitOut($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'])])
    // Practices are read in any mode (reading records nothing); the repository is sent only when the person listed it.
    const repoP = repoOf(gitFacts)
    const sectionP = config ? practicesSection($, config, repoP) : Promise.resolve(undefined)
    // The project the repository belongs to is asked beside the practices, not after them, inside the same bound.
    const projectP = config ? projectContext($, config, repoP) : Promise.resolve(undefined)
    if (config && mode !== 'off') {
      // An entry left open by a session that never ended is held as it stood.
      await withJournal(async () => {
        const journal = await load($)
        for (const entry of journal) {
          if (entry.status === 'open') {
            entry.status = 'held'
            entry.endedAt ??= entry.startedAt
          }
        }
        await save($, journal)
        // A key changed since a 401 lifts the stop. The flush is not awaited: a host that hangs must not hold the first prompt.
        const queue = await queueOf($)
        const lifted = liftStop(queue, fingerprint)
        if (lifted !== queue) await $.store.set('queue', lifted)
      })
      void flush($).then(() => showStatus($)).catch(() => undefined)
      // The briefing is always read, for the policy (auto-send, brain off); `sync` only decides whether yesterday joins the prompt.
      const briefing: Briefing | undefined = await getBriefing($, config, day(await $.clock.now()))
      if (briefing?.brain === 'off') brainOff = true
      // No briefing (offline, no cache for today): forget an older day's `allowed`, so mode `auto` holds until one answers.
      if (!briefing) await $.store.delete('autoSend')
      if (briefing) {
        await $.store.set('autoSend', briefing.autoSend)
        await $.store.set('view', { day: briefing.day, today: briefing.today, yesterday: briefing.yesterday, related: briefing.related } satisfies View)
        if (sync) yesterday = yesterdaySection(briefing.yesterday)
      }
      // After the briefing, so it never delays it; the line is redrawn when the answer comes.
      void refreshSpend($).then(() => showStatus($)).catch(() => undefined)
      const [remote, top, branch] = await gitFacts
      const slug = repoSlug(remote ?? '')
      if (isAllowed(repos, slug)) {
        repoRoot = top ?? cwd
        allowed = { repo: slug, ...(branch && branch !== 'HEAD' && { branch }) }
        // Paused or brain off: nothing is opened now; /brain resume opens it.
        if (!(await paused($))) await openEntry($, allowed.repo, allowed.branch)
      }
      void $.clock.every(FLUSH_MS, () => flush($))
    }
    practices = await sectionP
    project = projectSection(await projectP)
    await showStatus($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    // Order: the project's goals, then practices, then yesterday. The server's heading and footer frame the project as data; practices are the admins' rules.
    const sections = [...result.sections, ...(project ? [{ id: SECTION_PROJECT, text: project, scope: 'session' as const }] : []), ...(practices ? [{ id: SECTION_PRACTICES, text: practices, scope: 'session' as const }] : []), ...(yesterday ? [{ id: SECTION, text: yesterday, scope: 'session' as const }] : [])]
    return sections.length === result.sections.length ? result : { sections }
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    // A session that went on without a start (after /clear) or was paused and resumed is recorded from its next prompt.
    if (ownPrompt !== undefined && e.text === ownPrompt) {
      ownPrompt = undefined
      return next(e)
    }
    if (!current && allowed && config && mode !== 'off' && !e.command && !e.isMeta && !(await paused($))) await openEntry($, allowed.repo, allowed.branch).catch(() => undefined)
    if (current && !e.command && !e.isMeta) {
      current.turns += 1
      // The first prompt is read once, for the title; it is kept nowhere.
      if (current.turns === 1) current.title = titleFrom(e.text)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: BRAIN_ASK_FULL }, async ($, e) => {
    const question = questionOf(e)
    if (!config) return { result: { content: 'The brain is not set up: add the Landflow URL and key in the mod options.' }, isError: true } as never
    if (!question) return { result: { content: 'Give a question.' }, isError: true } as never
    const answer = await brainAsk($, config, question)
    return { result: { content: answer.text }, ...(answer.isError && { isError: true }) } as never
  })

  on('tool.call', { tool: PRACTICES_FULL }, async ($, e) => {
    if (!config) return { result: { content: 'The brain is not set up: add the Landflow URL and key in the mod options.' }, isError: true } as never
    const answer = await practicesTool($, config, practicesInput(e), repoHere)
    return { result: { content: answer.text }, ...(answer.isError && { isError: true }) } as never
  })

  on('tool.call', { tool: PRACTICE_DRAFT_FULL }, async ($, e) => {
    if (!config) return { result: { content: 'The brain is not set up: add the Landflow URL and key in the mod options.' }, isError: true } as never
    const answer = await practiceDraftTool($, config, e)
    return { result: { content: answer.text }, ...(answer.isError && { isError: true }) } as never
  })

  on('tool.call', async ($, e, next) => {
    // Observe after the call: never deny, never change what the tool answers.
    const result = await next(e)
    try {
      if (current && result.deny === undefined) {
        const input = e as unknown as Record<string, unknown>
        if (typeof input.file_path === 'string' && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(e.tool)) {
          current.areas = addArea(current.areas, areaOf(input.file_path, repoRoot))
        } else if (e.tool === 'Bash' && typeof input.command === 'string') {
          const out = (result as unknown as { result?: { stdout?: unknown } }).result?.stdout
          const failed = (result as unknown as { isError?: boolean }).isError === true
          const facts = bashFacts(input.command, typeof out === 'string' ? out : '', failed)
          current.commits += facts.commits
          current.prs = addPrs(current.prs, facts.prs)
        }
      }
    } catch {
      // Observing never breaks a tool call.
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (current && !e.agentId) await upsert($, current).catch(() => undefined)
    if (config && showSpend && mode !== 'off' && !e.agentId) {
      const now = await $.clock.now()
      if (now - spendAt >= SPEND_EVERY_MS) {
        spendAt = now // before any await, so a second turn.complete straight after does not ask again
        void refreshSpend($).then(() => showStatus($)).catch(() => undefined)
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    try {
      // /clear and an in-process resume end the session id but not the process, and no session.start follows: open the next entry here.
      const goesOn = (e.reason === 'clear' || e.reason === 'resume') && allowed
      const where = allowed
      await closeCurrent($, e.sessionId, true)
      if (!goesOn) allowed = undefined
      else if (where && !(await paused($))) await openEntry($, where.repo, where.branch)
    } catch {
      // The session still ends.
    }
    await showStatus($).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The pane draws only when the person opened it (`/brain`, `/brain sync`); nothing opens it on its own.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const view = await storedView($)
    return drawPane($, e, view, async (sourceId, source) => {
      const item = view?.today.concat(view.yesterday).find(one => one.sourceId === sourceId)
      $.ui.toast(await postUpdate($, sourceId, item?.title ?? sourceId, source))
    })
  }).catch(($, e, next) => next(e))

  // The band: one line, only while a colleague touched the same thing, dismissable for the day.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!config || mode === 'off' || e.props.hasSurvey) return next(e)
    const view = await storedView($)
    const line = bandLine(view, (await $.store.get('bandDismissed')) as string | undefined)
    if (!line || !view) return next(e)
    return drawBand($, e, line, () => $.store.set('bandDismissed', view.day))
  }).catch(($, e, next) => next(e))

  const reply = (text: string) => ({ text })

  on('command.run', { command: 'brain' }, async ($, e, next) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ').trim()
    // Practices need only the URL and key: reading records nothing, and learning sends nothing from the checkout but drafts.
    if (config && sub === 'practices') return reply(await practicesCommand($))
    if (config && sub === 'project') return reply(await projectCommand($))
    if (config && sub === 'learn') return reply(await learnCommand($, rest.filter(Boolean)))
    if (!config || mode === 'off') return reply('landflow-brain is not set up: it needs the Landflow URL (https, or http://localhost), an API key with the brain:write scope, and a mode other than off. Nothing is recorded or sent.')
    const journal = await load($)
    const all = current ? [...journal.filter(entry => entry.id !== current?.id), current] : journal
    switch (sub) {
      case '':
      case 'sync': {
        const view = await viewOf($, sub === 'sync')
        // Where there is no pane to open, /brain sync still answers with its text.
        const opened = await $.ui.open({ id: PANE_ID, title: 'Brain' }).then(() => true, () => false)
        if (sub === 'sync') return reply(syncText(view))
        return reply(opened ? 'Brain pane opened (Esc closes it). /brain sync lists yesterday and your colleagues here.' : 'There is no pane here; /brain sync lists yesterday and your colleagues as text.')
      }
      case 'post': {
        const view = await viewOf($, false)
        const item = (view?.today ?? []).concat(view?.yesterday ?? []).find(one => one.sourceId === arg)
        const entry = all.find(one => one.id === arg || one.sourceId === arg)
        if (item && !canPost(item)) return reply('That item is an update you already posted; there is nothing to post again.')
        const sourceId = item?.sourceId ?? (entry?.status === 'sent' ? entry.sourceId : undefined)
        if (!arg || !sourceId) return reply('Say which of your sent items: /brain post <id>. /brain today lists the ids.')
        // The item's own source; an item only the journal knows is the mod's (`claude-code`).
        return reply(await postUpdate($, sourceId, item?.title ?? entry?.title ?? arg, item ? (item.source ?? '') : 'claude-code'))
      }
      case 'visibility': {
        const [id = '', who = ''] = arg.split(/\s+/)
        const choice = VISIBILITIES.find(v => v === who.toLowerCase())
        const entry = all.find(item => item.id === id || item.sourceId === id)
        if (!entry || !choice) return reply('/brain visibility <id> private|team|org')
        const result = await setVisibility($, entry, choice)
        return reply(`${entry.id}: ${result}`)
      }
      case 'today': {
        const today = day(await $.clock.now())
        const rows = all.filter(entry => (entry.status === 'held' || entry.status === 'sent' || entry.status === 'open') && day(Date.parse(entry.startedAt)) === today)
        return reply(rows.length ? `Today:\n${rows.map(describe).join('\n')}` : 'Nothing today yet.')
      }
      case 'status': {
        const sent = journal.filter(entry => entry.status === 'sent')
        const queue = await queueOf($)
        const lines = sent.map(entry => `${entry.id} sent ${entry.sentAt ?? ''}: ${JSON.stringify(entry.sentEvent ?? toEvent(entry))}`)
        const problems = ((await $.store.get('problems')) as string[] | undefined) ?? []
        const forgetting = journal.filter(entry => entry.status === 'forgetting')
        const waiting = queue.items.length
        return reply(
          [
            `brain: ${queue.stopped === 'key' ? 'key rejected' : (await paused($)) ? 'paused' : 'on'} · ${journal.filter(entry => entry.status === 'held').length} held · ${waiting} waiting to send (at most ${QUEUE_MAX})${waiting && queue.nextAt ? `, next try in ${Math.max(0, Math.round((queue.nextAt - (await $.clock.now())) / 1000))} s (backoff ${Math.round(backoffMs(queue.failures) / 1000)} s)` : ''}`,
            lines.length ? `Sent, exactly as it went:\n${lines.join('\n')}` : 'Nothing has been sent.',
            ...(problems.length ? [`Not accepted by the brain: ${problems.join('; ')}`] : []),
            ...(forgetting.length ? [`${forgetting.length} deleted here, waiting to be deleted in the brain (retried every minute; /brain forget <id> tries now): ${forgetting.map(entry => entry.id).join(', ')}`] : []),
          ].join('\n'),
        )
      }
      case 'pause':
        await $.store.set('paused', true)
        // The running session's entry is closed and held as it stands; nothing more is added to it or sent.
        await closeCurrent($, undefined, false)
        await showStatus($)
        return reply('Paused: the running session is closed and held as it stands, and nothing more is recorded or sent until /brain resume.')
      case 'resume':
        if (brainOff) return reply('The brain is off on the server, so nothing is recorded or sent, whatever /brain resume says.')
        await $.store.set('paused', false)
        if (!current && allowed && !brainOff) await openEntry($, allowed.repo, allowed.branch)
        await showStatus($)
        return reply('Resumed. This session is recorded again from now on, as a new entry.')
      case 'forget': {
        const entry = all.find(item => item.id === arg || item.sourceId === arg)
        if (!arg || !entry) return reply('Say which: /brain forget <id>. /brain today lists the ids.')
        const wasRunning = current?.id === entry.id
        if (wasRunning) current = undefined
        // A sent entry stays in the journal until the brain says the copy is gone (204 or 404).
        const { wasSent, deleted } = await takeOut($, entry)
        let note = wasRunning ? 'Dropped here. Recording goes on from your next prompt as a new entry; /brain pause stops it.' : 'Dropped here.'
        if (wasSent) {
          if (deleted === 204 || deleted === 404) {
            note = 'Dropped here and deleted from the brain.'
          } else {
            note = 'Dropped here; the brain could not be reached, so the copy there is not deleted yet. It is retried every minute while a session runs, or run /brain forget again.'
          }
        }
        await showStatus($)
        return reply(`${entry.id}: ${note}`)
      }
      case 'review': {
        const held = journal.filter(entry => entry.status === 'held')
        if (!held.length) return reply('Nothing is held for review.')
        const done: string[] = []
        for (const entry of held) {
          try {
            for (;;) {
              const shown = `${entry.repo}: "${entry.title}" (${entry.turns} turns, ${entry.commits} commits, ${entry.prs.length} PRs${entry.areas.length ? `; ${entry.areas.slice(0, 5).join(', ')}` : ''}). Send it to the brain, private to you? Send wider lets you pick team or org. Or type a new title under Other.`
              const answer = await $.ui.ask(shown, ['Send', 'Send wider', 'Drop', 'Skip'])
              if (answer === 'Send' || answer === 'Send wider') {
                entry.visibility = 'private'
                if (answer === 'Send wider') {
                  // Private stays the default: only an explicit Team or Org widens it, and Back goes to the first question.
                  const who = await $.ui.ask('Who can read this item?', ['Team', 'Org', 'Back'])
                  if (who === 'Back') continue
                  entry.visibility = who === 'Team' ? 'team' : who === 'Org' ? 'org' : 'private'
                }
                await send($, entry)
                const after = (await load($)).find(item => item.id === entry.id)
                const waiting = (await queueOf($)).items.some(item => item.event.sourceId === entry.sourceId)
                done.push(`${entry.id} ${after?.status === 'sent' ? 'sent' : waiting ? 'queued' : 'not accepted (/brain status says why)'}`)
                break
              }
              if (answer === 'Drop') {
                // A flush may have sent it while the question was open, or it may wait in the queue: take it out of both.
                const { wasSent, deleted } = await takeOut($, entry)
                entry.status = 'dropped'
                const gone = deleted === 204 || deleted === 404
                done.push(`${entry.id} dropped${!wasSent ? '' : gone ? '; it had been sent already, so it was deleted from the brain' : '; it had been sent already and the brain could not be reached, so the copy there is deleted later (retried every minute)'}`)
                break
              }
              if (answer === 'Skip') break
              entry.title = titleFrom(answer)
            }
          } catch {
            return reply(`${held.length} held; nobody to ask here. ${held.map(describe).join('\n')}`)
          }
        }
        await withJournal(async () => {
          const fresh = await load($)
          for (const entry of held) {
            const at = fresh.findIndex(item => item.id === entry.id)
            if (at >= 0 && entry.status !== 'dropped') fresh[at] = { ...fresh[at]!, title: entry.title, ...(entry.visibility && { visibility: entry.visibility }) }
          }
          await save($, fresh)
        })
        await showStatus($)
        return reply(done.length ? done.join('\n') : 'Nothing sent.')
      }
      default:
        return reply('/brain | sync | today | review | status | pause | resume | forget <id> | visibility <id> private|team|org | post <id> | practices | learn [paths] | project')
    }
  }).catch(($, e, next) => (next.called ? next(e) : { text: '/brain failed; nothing was sent.' }))
}
