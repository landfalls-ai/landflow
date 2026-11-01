/**
 * landflow-harness (docs/a2a.md, "The landflow-harness mod"): what Landflow adds to its Claude Code agents on kagent.
 *
 * Trace. A request from a Landflow run carries a line `<!-- landflow-trace <url> [guard=strict|enforce|report|off] -->`; the mod
 * takes it off the prompt and, until the turn ends, sends what Claude Code does to that URL: each model request's tokens,
 * model and time (its subagents' too, and the tool calls the API ran itself), each tool call's time and outcome, the
 * subagents it starts, what the guardrails stopped and the turn's end. Events go out in batches as they come, at most
 * every few seconds, and once more before the turn ends, so the run has them when the answer arrives.
 *
 * Guard. Before a tool call runs, the rules in ./rules.ts refuse what an agent here never needs to do: read secret
 * files, print the environment, push to main or force-push, merge pull requests, change git's auth settings, delete the
 * machine, upload files, write outside its workspace. The model reads the reason as the tool's error and carries on.
 * A push to main or master, a force push and deleting a remote branch are asked of a person instead (Normal mode, when the
 * request carries a trace URL): the mod posts an `ask` event, waits for the answer and runs the command only if approved.
 * `guard=report` only reports what would have been refused; `guard=off` neither. `guard=strict` also keeps the agent
 * read-only on the code (rules.ts `guardReadOnly`). The agent's own mode is the `guard` option, which Landflow sets per
 * agent when it deploys it (the packed plugin.json's default): a request's marker can make it stricter, never looser.
 *
 * Redact. A tool's result is kept with every token or key it shows masked (`[redacted GitHub token]`), so a secret that
 * reached a file or a command's output never reaches the model or the transcript.
 */
import type { EngineInterface, Register } from 'claude-code'
import { guardBash, guardFile, guardReadOnly, redact, type Verdict } from './rules'

const MARKER = /^[ \t]*<!--[ \t]*landflow-trace[ \t]+(https?:\/\/[^\s>]+)((?:[ \t]+[a-z]+=[a-z]+)*)[ \t]*-->[ \t]*(\r?\n)?/m
const VERSION = '0.4.0'
/** Events go out at most this often while a turn runs, ms. */
const EVERY_MS = 3000
/** Events kept while Landflow can't be reached; the oldest go first. */
const MAX_EVENTS = 500
/** A tool call is shown by the first of these arguments it has. */
const ARG_KEYS = ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'description', 'skill', 'prompt']
const ARG_CHARS = 160
/** How long an ask waits for a person before the command is refused, ms. */
const ASK_MS = 10 * 60_000
/** Each poll of an ask's answer waits this long on Landflow's side (seconds), so a decision arrives at once and the hook's own clock stays still. */
const ASK_POLL_S = 25
const ASK_COMMAND_CHARS = 1000

type Guard = 'strict' | 'enforce' | 'report' | 'off'
/** From the loosest to the strictest. */
const GUARDS: readonly Guard[] = ['off', 'report', 'enforce', 'strict']
const stricter = (a: Guard, b: Guard | undefined): Guard => (b && GUARDS.indexOf(b) > GUARDS.indexOf(a) ? b : a)
const guardOf = (value: unknown): Guard | undefined => (typeof value === 'string' && (GUARDS as readonly string[]).includes(value) ? (value as Guard) : undefined)
type TraceEvent = Record<string, string | number | boolean | string[] | undefined>
/** A content block as a row holds it (ApiContentBlock). */
type Block = { type: string; [field: string]: unknown }

/** What the mod keeps between hooks. */
interface State {
  /** Where this turn's events go: the URL of its prompt's marker, until the turn ends. */
  target?: string
  /** This turn's mode: the agent's, or stricter when the marker asks. */
  guard: Guard
  /** The agent's own mode (the `guard` option), which no marker loosens. */
  floor: Guard
  /** Where the agent may write: its working directory, /tmp and Claude Code's own folder. */
  roots: string[]
  cwd: string
  queue: Array<{ url: string; event: TraceEvent }>
  sending?: Promise<void>
  sentAt: number
  /** URLs Landflow answered 404 or 410 (the run's call ended): nothing more goes there. */
  closed: Set<string>
  /** Asks made so far, to name the next. */
  asks: number
}

const cut = (text: string) => (text.length > ARG_CHARS ? `${text.slice(0, ARG_CHARS)}…` : text)

function argOf(input: Record<string, unknown>): string | undefined {
  for (const key of ARG_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return cut(redact(value.trim().replace(/\s+/g, ' ')).text)
  }
  return undefined
}

function optionsOf(text: string): { guard?: Guard } {
  const guard = /\bguard=(strict|enforce|report|off)\b/.exec(text)?.[1] as Guard | undefined
  return guard ? { guard } : {}
}

function record(state: State, event: TraceEvent) {
  const url = state.target
  if (!url || state.closed.has(url)) return
  state.queue.push({ url, event })
  if (state.queue.length > MAX_EVENTS) state.queue.splice(0, state.queue.length - MAX_EVENTS)
}

/** One POST per URL with what is queued. A batch that fails is dropped: the run keeps its estimate for it. */
function send($: EngineInterface, state: State, at: number): Promise<void> {
  if (state.sending) return state.sending
  if (!state.queue.length) return Promise.resolve()
  const batch = state.queue
  state.queue = []
  state.sentAt = at
  state.sending = (async () => {
    const byUrl = new Map<string, TraceEvent[]>()
    for (const { url, event } of batch) {
      const events = byUrl.get(url) ?? []
      events.push(event)
      byUrl.set(url, events)
    }
    for (const [url, events] of byUrl) {
      try {
        const response = await $.http.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events }) })
        if (response.status === 404 || response.status === 410) state.closed.add(url)
      } catch {
        // Landflow can't be reached: these are lost, the next batch tries again.
      }
    }
  })().finally(() => {
    state.sending = undefined
  })
  return state.sending
}

/** Send while the turn runs, not on every event. */
function soon($: EngineInterface, state: State, at: number) {
  if (at - state.sentAt >= EVERY_MS) void send($, state, at)
}

/** What the guardrails say about a tool call, if anything. */
function verdictOf(state: State, tool: string, input: Record<string, unknown>): Verdict | undefined {
  if (state.guard === 'off') return undefined
  if (state.guard === 'strict') {
    const verdict = guardReadOnly(tool, input, state.cwd)
    if (verdict) return verdict
  }
  if (tool === 'Bash' && typeof input.command === 'string') return guardBash(input.command, state.cwd)
  return guardFile(tool, input, state.roots, state.cwd)
}

/** What a person said to an ask: `person` is false when nobody could answer (Landflow unreachable, the call ended, no answer in time). */
interface Answer {
  approved: boolean
  person: boolean
  message?: string
}

/**
 * Ask Landflow to put a command to a person and wait for the answer. The ask is posted at once; the answer is read by
 * long polls (Landflow holds each for up to ASK_POLL_S seconds and answers when a person decides), so the wait costs the
 * hook none of its own time. Gives up after ASK_MS.
 */
async function askPerson($: EngineInterface, state: State, command: string, cwd: string, reason: string, agent: string | undefined): Promise<Answer> {
  const url = state.target
  const shown = cut(redact(command.trim()).text)
  const unreachable: Answer = { approved: false, person: false, message: `Landflow couldn't ask a person, so this didn't run: ${shown}` }
  if (!url || state.closed.has(url)) return unreachable
  const started = await $.clock.now()
  const askId = `ask-${++state.asks}-${started.toString(36)}`
  await send($, state, started)
  try {
    const event: TraceEvent = { type: 'ask', at: started, askId, command: redact(command.trim()).text.slice(0, ASK_COMMAND_CHARS), cwd, reason, agent }
    const posted = await $.http.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: [event] }) })
    if (posted.status >= 300) return unreachable
  } catch {
    return unreachable
  }
  let failures = 0
  for (;;) {
    if ((await $.clock.now()) - started >= ASK_MS) return { approved: false, person: false, message: `Nobody answered in ${ASK_MS / 60_000} minutes, so this didn't run: ${shown}` }
    try {
      const response = await $.http.fetch(`${url}/asks/${askId}?wait=${ASK_POLL_S}`, { method: 'GET' })
      if (response.status === 404 || response.status === 410) return unreachable
      const body = (response as unknown as { text: string | (() => Promise<string>) }).text
      const parsed = JSON.parse((typeof body === 'function' ? await body() : body) || '{}') as { decision?: string; expired?: boolean }
      failures = 0
      if (parsed.decision === 'approved') return { approved: true, person: true }
      if (parsed.decision === 'denied') {
        if (parsed.expired) return { approved: false, person: false, message: `Nobody answered in time, so this didn't run: ${shown}` }
        return { approved: false, person: true, message: `A person denied: ${shown}` }
      }
    } catch {
      if (++failures >= 5) return unreachable
      await $.clock.sleep(1000)
    }
  }
}

/** A block's text with secrets masked, and the kinds masked (a tool_result's content is text or text blocks). */
function maskBlock(block: Block, found: Set<string>): Block {
  const mask = (text: string) => {
    const masked = redact(text)
    for (const kind of masked.found) found.add(kind)
    return masked.text
  }
  if (block.type === 'text' && typeof block.text === 'string') return { ...block, text: mask(block.text) }
  if (block.type !== 'tool_result') return block
  if (typeof block.content === 'string') return { ...block, content: mask(block.content) }
  if (Array.isArray(block.content)) {
    return { ...block, content: block.content.map(part => (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string' ? { ...part, text: mask((part as { text: string }).text) } : part)) }
  }
  return block
}

export const register: Register = (on, options) => {
  const floor = guardOf(options.guard) ?? 'enforce'
  const state: State = { guard: floor, floor, roots: [], cwd: '/', queue: [], sentAt: 0, closed: new Set(), asks: 0 }

  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('HOME')) ?? ''
    state.cwd = e.cwd || '/'
    state.roots = [...new Set([state.cwd, '/tmp', ...(home ? [`${home.replace(/\/+$/, '')}/.claude`] : [])])]
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const found = e.command ? null : MARKER.exec(e.text)
    const url = found?.[1]
    if (!found || !url) return next(e)
    state.target = url
    state.guard = stricter(state.floor, optionsOf(found[2] ?? '').guard)
    record(state, { type: 'start', at: await $.clock.now(), mod: VERSION, guard: state.guard })
    return next({ ...e, text: e.text.replace(MARKER, '') })
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (!state.target) return yield* next(e)
    const started = await $.clock.now()
    const result = yield* next(e)
    const at = await $.clock.now()
    const usage = result.usage
    const server = (result.serverToolUses ?? []).map(use => use.name)
    record(state, {
      type: 'step',
      at,
      ms: at - started,
      turn: e.turnId,
      index: e.index,
      agent: e.agentId,
      model: usage?.model ?? e.model,
      stop: result.stopReason ?? undefined,
      input: usage?.input_tokens ?? 0,
      output: usage?.output_tokens ?? 0,
      cacheRead: usage?.cache_read_input_tokens ?? 0,
      cacheWrite: usage?.cache_creation_input_tokens ?? 0,
      tools: result.toolUses.map(use => use.name),
      server: server.length ? server : undefined,
    })
    soon($, state, at)
    return result
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const verdict = verdictOf(state, e.tool, input)
    if (verdict?.ask && state.guard === 'enforce' && state.target && e.tool === 'Bash') {
      // A person may allow this one: ask, and run it only if they approve.
      const at = await $.clock.now()
      const answer = await askPerson($, state, String(input.command ?? ''), state.cwd, verdict.reason, e.agentId)
      if (!answer.approved) {
        if (!answer.person) record(state, { type: 'guard', at: await $.clock.now(), rule: verdict.rule, tool: e.tool, agent: e.agentId, arg: argOf(input), reason: answer.message, action: 'deny' })
        soon($, state, at)
        return { deny: answer.message ?? 'A person denied this command.' }
      }
    } else if (verdict) {
      const at = await $.clock.now()
      const refused = state.guard === 'enforce' || state.guard === 'strict'
      record(state, { type: 'guard', at, rule: verdict.rule, tool: e.tool, agent: e.agentId, arg: argOf(input), reason: verdict.reason, action: refused ? 'deny' : 'report' })
      soon($, state, at)
      if (refused) return { deny: `Landflow's guardrails stopped this (${verdict.rule}): ${verdict.reason}` }
    }
    if (!state.target) return next(e)
    const started = await $.clock.now()
    const result = await next(e)
    const at = await $.clock.now()
    const denied = result.deny !== undefined
    record(state, {
      type: 'tool',
      at,
      ms: at - started,
      tool: e.tool,
      agent: e.agentId,
      ok: !denied && result.isError !== true,
      denied: denied || undefined,
      arg: argOf(input),
    })
    soon($, state, at)
    return result
  }).catch(($, e, next) => (next.called ? next(e) : { deny: "Landflow's guardrails couldn't check this tool call, so it didn't run. Try again." }))

  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    const found = new Set<string>()
    const content = e.message.content.map(block => maskBlock(block, found))
    if (!found.size) return next(e)
    record(state, { type: 'redact', at: await $.clock.now(), agent: e.agentId, kinds: [...found] })
    return next({ ...e, message: { ...e.message, content } })
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (state.target && result.deny === undefined && result.agentId) {
      record(state, { type: 'spawn', at: await $.clock.now(), agent: result.agentId, kind: e.subagentType, description: cut(e.description), model: result.model })
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (state.target) {
      const at = await $.clock.now()
      record(state, { type: 'turn', at, ms: e.durationMs, turn: e.turnId, agent: e.agentId, reason: e.reason })
      if (!e.agentId) {
        // The request's turn ends: everything goes now, before the answer does, and the next prompt names its own URL.
        await send($, state, at)
        await send($, state, at)
        state.target = undefined
        state.guard = state.floor
      }
    }
    return next(e)
  })
}
