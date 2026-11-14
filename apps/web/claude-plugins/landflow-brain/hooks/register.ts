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
import { QUEUE_MAX, backoffMs, deleteWork, due, emptyQueue, enqueue, getBriefing, postWork, serverUrl, settle, type Briefing, type Config, type Queue } from './client'
import { addArea, addPrs, areaOf, bashFacts, isAllowed, newEntry, parseRepos, repoSlug, type Entry } from './journal'
import { titleFrom, toEvent } from './summary'

const FLUSH_MS = 60_000
/** The journal keeps this many entries and this many days. */
const JOURNAL_MAX = 200
const JOURNAL_DAYS = 14
const YESTERDAY_CHARS = 1200
const SECTION = 'landflow-brain:yesterday'

const day = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

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
/** This session's entry, until it ends. */
let current: Entry | undefined
let cwd = '/'
let repoRoot = '/'
/** Set for the session when the brain is off on the server. */
let brainOff = false
let yesterday: string | undefined
let flushing: Promise<void> | undefined

async function load($: EngineInterface): Promise<Entry[]> {
  return (((await $.store.get('journal')) as Entry[] | undefined) ?? []).filter(Boolean)
}

async function save($: EngineInterface, journal: Entry[]) {
  const horizon = (await $.clock.now()) - JOURNAL_DAYS * 86_400_000
  const kept = journal.filter(entry => entry.status !== 'dropped' && Date.parse(entry.startedAt) >= horizon).slice(-JOURNAL_MAX)
  await $.store.set('journal', kept)
}

async function upsert($: EngineInterface, entry: Entry) {
  const journal = await load($)
  const at = journal.findIndex(item => item.id === entry.id)
  if (at >= 0) journal[at] = entry
  else journal.push(entry)
  await save($, journal)
}

async function queueOf($: EngineInterface): Promise<Queue> {
  return ((await $.store.get('queue')) as Queue | undefined) ?? emptyQueue()
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
  $.ui.status(`brain: on · ${held} held`)
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

async function flushOnce($: EngineInterface) {
  if (!config) return
  let queue = await queueOf($)
  const now = await $.clock.now()
  const batch = due(queue, now)
  if (!batch.length) return
  const result = await postWork($, config, batch.map(item => item.event))
  queue = settle(queue, batch, result.status, now)
  await $.store.set('queue', queue)
  if (result.status !== undefined && result.status >= 200 && result.status < 300) {
    const journal = await load($)
    const sent = new Set(result.saved)
    for (const entry of journal) {
      if (entry.status === 'held' && sent.has(entry.sourceId)) {
        entry.status = 'sent'
        entry.sentAt = new Date(now).toISOString()
      }
    }
    await save($, journal)
  }
}

async function send($: EngineInterface, entry: Entry) {
  const now = await $.clock.now()
  await $.store.set('queue', enqueue(await queueOf($), toEvent(entry), now))
  await flush($)
}

async function gitOut($: EngineInterface, argv: string[]): Promise<string | undefined> {
  try {
    const result = await $.process.run(argv, { cwd, timeoutMs: 3000 })
    return result.exitCode === 0 ? result.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

export const register: Register = (on, options) => {
  const url = serverUrl(options.url)
  const key = typeof options.key === 'string' ? options.key.trim() : ''
  repos = parseRepos(options.repos)
  mode = options.mode === 'auto' || options.mode === 'off' ? options.mode : 'review'
  sync = options.sync !== false
  config = url && key ? { url, key } : undefined
  current = undefined
  flushing = undefined

  on('session.start', async ($, e, next) => {
    cwd = e.cwd || '/'
    repoRoot = cwd
    current = undefined
    brainOff = false
    yesterday = undefined
    await $.command.register({ name: 'brain', description: 'Your work in the company brain: today, review, status, pause, resume, forget <id>', argumentHint: 'today | review | status | pause | resume | forget <id>' })
    if (config && mode !== 'off') {
      // An entry left open by a session that never ended is held as it stood.
      const journal = await load($)
      for (const entry of journal) {
        if (entry.status === 'open') {
          entry.status = 'held'
          entry.endedAt ??= entry.startedAt
        }
      }
      await save($, journal)
      await flush($)
      if (sync) {
        const briefing: Briefing | undefined = await getBriefing($, config, day(await $.clock.now()))
        if (briefing?.brain === 'off') brainOff = true
        if (briefing) {
          await $.store.set('autoSend', briefing.autoSend)
          yesterday = yesterdaySection(briefing.yesterday)
        }
      }
      if (!(await paused($))) {
        const slug = repoSlug((await gitOut($, ['git', 'remote', 'get-url', 'origin'])) ?? '')
        if (isAllowed(repos, slug)) {
          repoRoot = (await gitOut($, ['git', 'rev-parse', '--show-toplevel'])) ?? cwd
          const branch = await gitOut($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
          const now = await $.clock.now()
          current = newEntry({ id: `e-${now.toString(36)}`, sourceId: `cc-${now.toString(36)}`, repo: slug, ...(branch && branch !== 'HEAD' && { branch }), now })
          await upsert($, current)
        }
      }
      void $.clock.every(FLUSH_MS, () => flush($))
    }
    await showStatus($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!yesterday) return result
    return { sections: [...result.sections, { id: SECTION, text: yesterday, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (current && !e.command && !e.isMeta) {
      current.turns += 1
      // The first prompt is read once, for the title; it is kept nowhere.
      if (current.turns === 1) current.title = titleFrom(e.text)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

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
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    try {
      if (current) {
        const entry = current
        current = undefined
        const now = await $.clock.now()
        entry.endedAt = new Date(now).toISOString()
        entry.sourceId = e.sessionId || entry.sourceId
        if (!entry.turns) {
          entry.status = 'dropped'
          await upsert($, entry)
        } else {
          entry.status = 'held'
          await upsert($, entry)
          const forbidden = (await $.store.get('autoSend')) === 'forbidden'
          if (mode === 'auto' && !forbidden && !(await paused($))) await send($, entry)
        }
      }
    } catch {
      // The session still ends.
    }
    await showStatus($).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  const reply = (text: string) => ({ text })

  on('command.run', { command: 'brain' }, async ($, e, next) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ').trim()
    if (!config || mode === 'off') return reply('landflow-brain is not set up: it needs the Landflow URL (https, or http://localhost), an API key with the brain:write scope, and a mode other than off. Nothing is recorded or sent.')
    const journal = await load($)
    const all = current ? [...journal.filter(entry => entry.id !== current?.id), current] : journal
    switch (sub) {
      case 'today': {
        const today = day(await $.clock.now())
        const rows = all.filter(entry => (entry.status === 'held' || entry.status === 'sent' || entry.status === 'open') && day(Date.parse(entry.startedAt)) === today)
        return reply(rows.length ? `Today:\n${rows.map(describe).join('\n')}` : 'Nothing today yet.')
      }
      case 'status': {
        const sent = journal.filter(entry => entry.status === 'sent')
        const queue = await queueOf($)
        const lines = sent.map(entry => `${entry.id} sent ${entry.sentAt ?? ''}: ${JSON.stringify(toEvent(entry))}`)
        const waiting = queue.items.length
        return reply(
          [
            `brain: ${queue.stopped === 'key' ? 'key rejected' : (await paused($)) ? 'paused' : 'on'} · ${journal.filter(entry => entry.status === 'held').length} held · ${waiting} waiting to send (at most ${QUEUE_MAX})${waiting && queue.nextAt ? `, next try in ${Math.max(0, Math.round((queue.nextAt - (await $.clock.now())) / 1000))} s (backoff ${Math.round(backoffMs(queue.failures) / 1000)} s)` : ''}`,
            lines.length ? `Sent, exactly as it went:\n${lines.join('\n')}` : 'Nothing has been sent.',
          ].join('\n'),
        )
      }
      case 'pause':
        await $.store.set('paused', true)
        await showStatus($)
        return reply('Paused: nothing more is recorded or sent until /brain resume.')
      case 'resume':
        await $.store.set('paused', false)
        await showStatus($)
        return reply('Resumed. A session that starts from now on is recorded again.')
      case 'forget': {
        const entry = all.find(item => item.id === arg || item.sourceId === arg)
        if (!arg || !entry) return reply('Say which: /brain forget <id>. /brain today lists the ids.')
        const wasSent = entry.status === 'sent' || (await queueOf($)).items.some(item => item.event.sourceId === entry.sourceId)
        const queue = await queueOf($)
        await $.store.set('queue', { ...queue, items: queue.items.filter(item => item.event.sourceId !== entry.sourceId) })
        entry.status = 'dropped'
        if (current?.id === entry.id) current = undefined
        await save($, [...journal.filter(item => item.id !== entry.id), entry])
        let note = 'Dropped here.'
        if (wasSent) {
          const status = await deleteWork($, config, entry.sourceId)
          note = status === 204 || status === 404 ? 'Dropped here and deleted from the brain.' : 'Dropped here; the brain could not be reached, so delete it there with /brain forget again later.'
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
              const shown = `${entry.repo}: "${entry.title}" (${entry.turns} turns, ${entry.commits} commits, ${entry.prs.length} PRs${entry.areas.length ? `; ${entry.areas.slice(0, 5).join(', ')}` : ''}). Send it to the brain, private to you? Or type a new title under Other.`
              const answer = await $.ui.ask(shown, ['Send', 'Drop', 'Skip'])
              if (answer === 'Send') {
                await send($, entry)
                done.push(`${entry.id} queued`)
                break
              }
              if (answer === 'Drop') {
                entry.status = 'dropped'
                done.push(`${entry.id} dropped`)
                break
              }
              if (answer === 'Skip') break
              entry.title = titleFrom(answer)
            }
          } catch {
            return reply(`${held.length} held; nobody to ask here. ${held.map(describe).join('\n')}`)
          }
        }
        const fresh = await load($)
        for (const entry of held) {
          const at = fresh.findIndex(item => item.id === entry.id)
          if (at >= 0) fresh[at] = { ...fresh[at]!, title: entry.title, status: entry.status === 'dropped' ? 'dropped' : fresh[at]!.status }
        }
        await save($, fresh)
        await showStatus($)
        return reply(done.length ? done.join('\n') : 'Nothing sent.')
      }
      default:
        return reply('/brain today | review | status | pause | resume | forget <id>')
    }
  }).catch(($, e, next) => (next.called ? next(e) : { text: '/brain failed; nothing was sent.' }))
}
