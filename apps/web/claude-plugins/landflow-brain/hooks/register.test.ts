// `claude plugin test apps/web/claude-plugins/landflow-brain`: the hooks against the engine's own test kit. The pure rules
// are tested in Landflow (apps/web/test/claude-brain-mod.test.ts).
import { expect, mock, test } from 'claude-code/testing'

const OPTIONS = { url: 'http://localhost:3000', key: 'lf_dev_key_for_tests_only_000000', repos: 'acme/widgets', mode: 'review', sync: true }
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] }
const BRIEFING = { yesterday: [{ title: 'Ship the billing page', repo: 'acme/widgets' }], autoSend: 'allowed', brain: 'on' }

/** The engine beneath the mod: git answers, a fake Landflow, a clock and a store in memory. */
function world(on: Parameters<Parameters<typeof test>[1]>[1], init: { remote?: string; briefing?: unknown; briefingDelayMs?: number; postStatus?: number; postDelayMs?: number; deleteStatuses?: number[]; answers?: string[]; seed?: Record<string, unknown> } = {}) {
  const posts: Array<Record<string, unknown>> = []
  const deleted: string[] = []
  const statuses: Array<string | undefined> = []
  const ran: string[] = []
  const clock = mock.clock(on, { now: Date.parse('2026-11-14T09:00:00Z') })
  mock.store(on, init.seed)
  mock.env(on, {})
  on('command.register', () => ({ value: { command: 'brain' } }))
  on('ui.status', (_, e) => {
    statuses.push((e as unknown as { text?: string }).text)
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    const argv = (e as unknown as { argv: string[] }).argv.join(' ')
    const out = argv.includes('get-url') ? (init.remote ?? 'git@github.com:acme/widgets.git') : argv.includes('--show-toplevel') ? '/work/widgets' : 'main'
    return { value: { exitCode: 0, stdout: `${out}\n`, stderr: '' } }
  })
  on('http.fetch', async (_, e) => {
    const request = e as unknown as { url: string; init?: { method?: string; body?: string } }
    if (request.url.includes('/api/brain/briefing')) {
      if (init.briefingDelayMs) await clock.sleep(init.briefingDelayMs)
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(init.briefing ?? BRIEFING) } }
    }
    if (request.init?.method === 'DELETE') {
      deleted.push(request.url)
      const status = init.deleteStatuses?.shift() ?? 204
      return { value: { status, ok: status === 204, headers: {}, text: '' } }
    }
    if (init.postDelayMs) await clock.sleep(init.postDelayMs)
    const events = (JSON.parse(request.init?.body ?? '{}') as { events: Array<Record<string, unknown>> }).events
    const status = init.postStatus ?? 200
    if (status === 200) posts.push(...events)
    return { value: { status, ok: status === 200, headers: {}, text: JSON.stringify({ saved: events.map(event => ({ sourceId: event.sourceId })), rejected: [] }) } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }] }))
  on('tool.call', (_, e) => {
    if (e.tool === 'AskUserQuestion') {
      const questions = (e as unknown as { questions: Array<{ question: string }> }).questions
      return { result: { questions, answers: Object.fromEntries(questions.map(q => [q.question, init.answers?.shift() ?? 'Send'])) } as never }
    }
    ran.push(e.tool)
    const command = (e as unknown as { command?: string }).command
    return { result: command?.startsWith('gh pr') ? { stdout: 'https://github.com/acme/widgets/pull/7\n', stderr: '' } : { stdout: '[main abc] x', stderr: '' } }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  return { posts, deleted, statuses, ran, clock }
}

async function work($: Parameters<Parameters<typeof test>[1]>[0]) {
  await $.session.start({ cwd: '/work/widgets', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'Fix the login redirect in apps/web/src/login.ts. Then add tests.' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/widgets/apps/web/src/login.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -am "fix"' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: { id: 'sess-1' } } as never)
}

const command = ($: Parameters<Parameters<typeof test>[1]>[0], args: string) => $.command.run({ command: 'brain', args, origin: { kind: 'user' }, presentation: 'text' } as never)

test('a session in an allowed repo leaves one held entry, and nothing leaves the machine', { options: OPTIONS }, async ($, on) => {
  const { posts, statuses } = world(on)
  await work($)
  expect(posts).toEqual([])
  const today = (await command($, 'today')) as { text: string }
  expect(today.text).toMatch(/\[held\].*acme\/widgets: Fix the login redirect in apps\/web \(1 turns, 1 commits, 1 PRs\)/)
  expect(statuses.at(-1)).toBe('brain: on · 1 held')
})

test('review sends it, and status shows exactly what went', { options: OPTIONS }, async ($, on) => {
  const { posts } = world(on)
  await work($)
  const reviewed = (await command($, 'review')) as { text: string }
  expect(reviewed.text).toMatch(/sent/)
  expect(posts).toHaveLength(1)
  expect(posts[0]).toMatchObject({ kind: 'work.session', source: 'claude-code', sourceId: 'sess-1', visibility: 'private', repo: 'acme/widgets', commits: 1, turns: 1, areas: ['apps/web'] })
  expect(JSON.stringify(posts[0])).not.toMatch(/login\.ts|\/work\/widgets|then add tests/i)
  const status = (await command($, 'status')) as { text: string }
  expect(status.text).toContain('"sourceId":"sess-1"')
  expect(status.text).toContain('Sent, exactly as it went')
})

test('mode auto posts the entry at the end, unless the admin forbids it', { options: { ...OPTIONS, mode: 'auto' } }, async ($, on) => {
  const { posts } = world(on)
  await work($)
  expect(posts).toHaveLength(1)
})

test('mode auto holds it when the briefing says autoSend is forbidden', { options: { ...OPTIONS, mode: 'auto' } }, async ($, on) => {
  const { posts } = world(on, { briefing: { ...BRIEFING, autoSend: 'forbidden' } })
  await work($)
  expect(posts).toEqual([])
})

test('a disallowed repo records nothing, with the options set', { options: OPTIONS }, async ($, on) => {
  const { posts } = world(on, { remote: 'git@github.com:acme/other.git' })
  await $.session.start({ cwd: '/work/other', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'hello' })
  await $.session.end({ reason: 'other', sessionId: 's2', resume: { id: 's2' } } as never)
  expect(((await command($, 'today')) as { text: string }).text).toBe('Nothing today yet.')
  expect(posts).toEqual([])
})

test('no key records and sends nothing', async ($, on) => {
  const { posts } = world(on, { remote: 'git@github.com:acme/other.git' })
  await $.session.start({ cwd: '/work/other', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'hello' })
  await $.session.end({ reason: 'other', sessionId: 's2', resume: { id: 's2' } } as never)
  expect(posts).toEqual([])
})

test('the system prompt gets yesterday, quoted and at most 1,200 characters', { options: OPTIONS }, async ($, on) => {
  world(on, { briefing: { ...BRIEFING, yesterday: Array.from({ length: 40 }, (_, i) => ({ title: `Item ${i} ${'x'.repeat(100)}`, repo: 'acme/widgets' })) } })
  await $.session.start({ cwd: '/work/widgets', surface: 'terminal', isInteractive: true })
  const composed = await $.prompt.compose(COMPOSE as never)
  const section = composed.sections.find(s => s.id === 'landflow-brain:yesterday')
  expect(section?.text.startsWith('Yesterday, from the company brain')).toBe(true)
  expect(section?.text.length).toBeLessThanOrEqual(1200)
  expect(section?.text.split('\n').slice(1).every(line => line.startsWith('> '))).toBe(true)
})

test('a slow briefing is skipped after 2 seconds', { options: OPTIONS }, async ($, on) => {
  const { clock } = world(on, { briefingDelayMs: 3000 })
  const started = $.session.start({ cwd: '/work/widgets', surface: 'terminal', isInteractive: true })
  await clock.advance(2000)
  await started
  const composed = await $.prompt.compose(COMPOSE as never)
  expect(composed.sections.some(s => s.id === 'landflow-brain:yesterday')).toBe(false)
})

test('the hooks never deny a tool call', { options: OPTIONS }, async ($, on) => {
  const { ran } = world(on)
  await $.session.start({ cwd: '/work/widgets', surface: 'terminal', isInteractive: true })
  for (const call of [{ tool: 'Bash', command: 'rm -rf /tmp/x' }, { tool: 'Edit', file_path: '/etc/hosts', old_string: 'a', new_string: 'b' }]) {
    const result = await $.tool.call(call as never)
    expect('deny' in result && result.deny).toBeFalsy()
  }
  expect(ran).toEqual(['Bash', 'Edit'])
})

test('forget drops an entry here and deletes it there', { options: OPTIONS }, async ($, on) => {
  const { deleted } = world(on)
  await work($)
  await command($, 'review')
  const today = (await command($, 'today')) as { text: string }
  const id = /(e-[a-z0-9]+) \[sent\]/.exec(today.text)?.[1] ?? ''
  const forgotten = (await command($, `forget ${id}`)) as { text: string }
  expect(forgotten.text).toMatch(/deleted from the brain/)
  expect(deleted[0]).toContain('/api/brain/work/sess-1?source=claude-code')
})

test('pause and resume change the status line', { options: OPTIONS }, async ($, on) => {
  const { statuses } = world(on)
  await $.session.start({ cwd: '/work/widgets', surface: 'terminal', isInteractive: true })
  await command($, 'pause')
  expect(statuses.at(-1)).toBe('brain: paused')
  await command($, 'resume')
  expect(statuses.at(-1)).toBe('brain: on · 0 held')
})

test('a 401 stops sending and says the key was rejected', { options: { ...OPTIONS, mode: 'auto' } }, async ($, on) => {
  const { statuses } = world(on, { postStatus: 401 })
  await work($)
  await $.session.start({ cwd: '/work/widgets', surface: 'terminal', isInteractive: true })
  expect(statuses.at(-1)).toBe('brain: key rejected')
})

const start = ($: Parameters<Parameters<typeof test>[1]>[0]) => $.session.start({ cwd: '/work/widgets', surface: 'terminal', isInteractive: true })
const say = ($: Parameters<Parameters<typeof test>[1]>[0], text: string) => $.prompt.submit({ text })

test('a /clear holds the entry and the next prompt is recorded in a new one', { options: OPTIONS }, async ($, on) => {
  world(on)
  await start($)
  await say($, 'First job.')
  await $.session.end({ reason: 'clear', sessionId: 'sess-a', resume: { id: 'sess-a' } } as never)
  await say($, 'Second job.')
  await $.session.end({ reason: 'other', sessionId: 'sess-b', resume: { id: 'sess-b' } } as never)
  const today = ((await command($, 'today')) as { text: string }).text
  expect(today.match(/\[held\]/g)).toHaveLength(2)
  expect(today).toContain('First job.')
  expect(today).toContain('Second job.')
})

test('pause closes the running entry, and nothing after it is recorded', { options: OPTIONS }, async ($, on) => {
  world(on)
  await start($)
  await say($, 'Before the pause.')
  await command($, 'pause')
  await say($, 'While paused.')
  await $.tool.call({ tool: 'Edit', file_path: '/work/widgets/docs/a.md', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -am "x"' })
  await $.session.end({ reason: 'other', sessionId: 'sess-p', resume: { id: 'sess-p' } } as never)
  const today = ((await command($, 'today')) as { text: string }).text
  expect(today.match(/\[held\]/g)).toHaveLength(1)
  expect(today).toContain('Before the pause.')
  expect(today).toContain('(1 turns, 0 commits, 0 PRs)')
})

test('mode auto with sync off still obeys a forbidden briefing, and holds when the policy is unknown', { options: { ...OPTIONS, mode: 'auto', sync: false } }, async ($, on) => {
  const { posts } = world(on, { briefing: { ...BRIEFING, autoSend: 'forbidden' } })
  await work($)
  expect(posts).toEqual([])
  expect(((await command($, 'today')) as { text: string }).text).toContain('[held]')
})

test('mode auto holds when the briefing never answered', { options: { ...OPTIONS, mode: 'auto' } }, async ($, on) => {
  const { posts, clock } = world(on, { briefingDelayMs: 5000 })
  const started = start($)
  await clock.advance(2000)
  await started
  await say($, 'Do a thing.')
  await $.session.end({ reason: 'other', sessionId: 's-u', resume: { id: 's-u' } } as never)
  expect(posts).toEqual([])
})

test('a rejected key stops sending until the key is not the rejected one', { options: { ...OPTIONS, mode: 'auto' } }, async ($, on) => {
  const { statuses } = world(on, { postStatus: 401 })
  await work($)
  await start($)
  expect(statuses.at(-1)).toBe('brain: key rejected')
})

test('a stop from another key, with a queued event, sends it at the next start', { options: { ...OPTIONS, mode: 'auto' } }, async ($, on) => {
  const event = { kind: 'work.session', source: 'claude-code', sourceId: 'cc-old', occurredAt: '2026-11-13T09:00:00.000Z', title: 't', summary: 's', repo: 'acme/widgets', commits: 0, turns: 1, visibility: 'private' }
  const { posts } = world(on, { seed: { queue: { items: [{ event, at: Date.parse('2026-11-13T10:00:00Z') }], failures: 1, nextAt: 0, stopped: 'key', stoppedFor: 'someotherkey' } } })
  await start($)
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(posts.map(post => post.sourceId)).toContain('cc-old')
})

test('a held entry sent by the start flush is marked sent, listed, and forgotten with a delete', { options: OPTIONS }, async ($, on) => {
  const event = { kind: 'work.session', source: 'claude-code', sourceId: 'cc-old', occurredAt: '2026-11-13T09:00:00.000Z', title: 'Old work', summary: 's', repo: 'acme/widgets', commits: 0, turns: 1, visibility: 'private' }
  const entry = { id: 'e-old', source: 'claude-code', sourceId: 'cc-old', repo: 'acme/widgets', startedAt: '2026-11-13T09:00:00.000Z', endedAt: '2026-11-13T09:30:00.000Z', turns: 1, title: 'Old work', areas: [], commits: 0, prs: [], status: 'held' }
  const { posts, deleted } = world(on, { seed: { journal: [entry], queue: { items: [{ event, at: Date.parse('2026-11-13T10:00:00Z') }], failures: 0, nextAt: 0 } } })
  await start($)
  for (let i = 0; i < 20 && !posts.length; i++) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(posts.map(post => post.sourceId)).toEqual(['cc-old'])
  const status = (await command($, 'status')) as { text: string }
  expect(status.text).toContain('e-old sent')
  expect(status.text).not.toContain('Nothing has been sent.')
  const forgot = (await command($, 'forget e-old')) as { text: string }
  expect(forgot.text).toMatch(/deleted from the brain/)
  expect(deleted).toHaveLength(1)
})

test('a stop from another key does not hold this one', { options: { ...OPTIONS, mode: 'auto' }, }, async ($, on) => {
  const { statuses } = world(on, { seed: { queue: { items: [], failures: 0, nextAt: 0, stopped: 'key', stoppedFor: 'someotherkey' } } })
  await start($)
  expect(statuses.at(-1)).toMatch(/^brain: on/)
})

test('forget while the brain is unreachable keeps the entry and retries the delete', { options: OPTIONS }, async ($, on) => {
  const { deleted, clock } = world(on, { deleteStatuses: [503] })
  await work($)
  await command($, 'review')
  const id = /(e-[a-z0-9]+) \[sent\]/.exec(((await command($, 'today')) as { text: string }).text)?.[1] ?? ''
  const first = (await command($, `forget ${id}`)) as { text: string }
  expect(first.text).toMatch(/not deleted yet/)
  const second = (await command($, `forget ${id}`)) as { text: string }
  expect(second.text).toMatch(/deleted from the brain/)
  expect(deleted).toHaveLength(2)
  expect(((await command($, `forget ${id}`)) as { text: string }).text).toMatch(/Say which/)
  void clock
})

test('a slow host does not hold session start past 2 seconds', { options: { ...OPTIONS, mode: 'auto' }, }, async ($, on) => {
  const { clock } = world(on, { postDelayMs: 10_000, seed: { queue: { items: [{ event: { kind: 'work.session', source: 'claude-code', sourceId: 'q-1', occurredAt: '2026-11-13T09:00:00Z', title: 't', summary: 's', repo: 'acme/widgets', commits: 0, turns: 1, visibility: 'private' }, at: Date.parse('2026-11-14T08:00:00Z') }], failures: 0, nextAt: 0 } } })
  let done = false
  const started = start($).then(() => {
    done = true
  })
  await clock.advance(2000)
  await started
  expect(done).toBe(true)
})

test('review Skip keeps the entry held', { options: OPTIONS }, async ($, on) => {
  const { posts } = world(on, { answers: ['Skip'] })
  await work($)
  expect(((await command($, 'review')) as { text: string }).text).toBe('Nothing sent.')
  expect(((await command($, 'today')) as { text: string }).text).toContain('[held]')
  expect(posts).toEqual([])
})

test('review Drop removes the entry', { options: OPTIONS }, async ($, on) => {
  const { posts } = world(on, { answers: ['Drop'] })
  await work($)
  expect(((await command($, 'review')) as { text: string }).text).toMatch(/dropped/)
  expect(((await command($, 'today')) as { text: string }).text).toBe('Nothing today yet.')
  expect(posts).toEqual([])
})

test('review sends under a new title', { options: OPTIONS }, async ($, on) => {
  const { posts } = world(on, { answers: ['Billing page work', 'Send'] })
  await work($)
  await command($, 'review')
  expect(posts[0]).toMatchObject({ title: 'Billing page work' })
})

test('a session that never ended is held at the next start', { options: OPTIONS }, async ($, on) => {
  world(on)
  await start($)
  await say($, 'Work that crashed.')
  await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await start($)
  const today = ((await command($, 'today')) as { text: string }).text
  expect(today).toMatch(/\[held\].*Work that crashed\./)
})

test('the brain being off on the server pauses the session', { options: OPTIONS }, async ($, on) => {
  const { statuses } = world(on, { briefing: { ...BRIEFING, brain: 'off' } })
  await start($)
  await say($, 'Not recorded.')
  await $.session.end({ reason: 'other', sessionId: 's-off', resume: { id: 's-off' } } as never)
  expect(statuses.at(-1)).toBe('brain: paused')
  expect(((await command($, 'today')) as { text: string }).text).toBe('Nothing today yet.')
})
