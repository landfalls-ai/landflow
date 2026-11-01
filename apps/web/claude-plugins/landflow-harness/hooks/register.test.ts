// `claude plugin test apps/web/claude-plugins/landflow-harness`: the hooks against the engine's own test kit. The rules
// themselves are tested in Landflow (apps/web/test/claude-harness-mod.test.ts).
import { expect, mock, test } from 'claude-code/testing'

const URL = 'http://landflow.test/api/agent-trace/t1'
const usage = { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 9000, cache_creation_input_tokens: 300, model: 'claude-sonnet-5-5' }

/** The engine beneath the mod: a network that keeps what was posted, tools that answer, a turn that ends. */
function world(on: Parameters<Parameters<typeof test>[1]>[1], answers: Array<Record<string, unknown>> = []) {
  const posts: Array<{ url: string; events: Array<Record<string, unknown>> }> = []
  const polls: string[] = []
  const ran: string[] = []
  const commands: string[] = []
  mock.clock(on, { now: 1000 })
  mock.env(on, { HOME: '/data' })
  on('http.fetch', (_, e) => {
    if (e.init?.method === 'GET') {
      // A poll of an ask: the next answer in `answers` (pending until a person decides).
      polls.push(e.url)
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(answers.shift() ?? { decision: 'pending' }) } }
    }
    posts.push({ url: e.url, events: JSON.parse(e.init?.body ?? '{}').events })
    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', (_, e) => {
    ran.push(e.tool)
    commands.push(String((e as unknown as { command?: string }).command ?? ''))
    return { result: {} }
  })
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'Bash', input: {} }], stopReason: 'tool_use' as const, usage }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return { posts, ran, polls, commands }
}

const events = (posts: Array<{ events: Array<Record<string, unknown>> }>) => posts.flatMap(p => p.events)

test('a marked request is traced and the marker never reaches the model', async ($, on) => {
  const { posts, ran } = world(on)
  await $.session.start({ cwd: '/data/workspace', surface: 'terminal', isInteractive: false })
  const submitted = await $.prompt.submit({ text: `<!-- landflow-trace ${URL} -->\nReview the branch` })
  expect(submitted.text).toBe('Review the branch')

  const stream = $.turn.step({ turnId: 'turn-1', index: 0, model: 'sonnet', messageCount: 1 })
  for await (const _chunk of stream);
  await stream.result
  await $.tool.call({ tool: 'Bash', command: 'pnpm test' })
  await $.turn.complete({ answer: 'VERDICT: approve', durationMs: 4200, isAborted: false, turnId: 'turn-1', reason: 'answer' })

  expect(ran).toEqual(['Bash'])
  expect(posts.every(p => p.url === URL)).toBe(true)
  const all = events(posts)
  expect(all.map(e => e.type)).toEqual(['start', 'step', 'tool', 'turn'])
  expect(all[1]).toMatchObject({ input: 1200, output: 80, cacheRead: 9000, cacheWrite: 300, model: 'claude-sonnet-5-5', tools: ['Bash'] })
  expect(all[2]).toMatchObject({ tool: 'Bash', ok: true, arg: 'pnpm test' })
  expect(all[3]).toMatchObject({ ms: 4200, reason: 'answer' })
})

test('a push to main asks a person and runs once they approve', async ($, on) => {
  const { posts, ran, polls } = world(on, [{ decision: 'pending' }, { decision: 'approved', by: 'ann@example.com' }])
  await $.session.start({ cwd: '/data/workspace', surface: 'terminal', isInteractive: false })
  await $.prompt.submit({ text: `<!-- landflow-trace ${URL} -->\nShip it` })
  const result = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'turn-1', reason: 'answer' })

  expect(result.deny).toBeUndefined()
  expect(ran).toEqual(['Bash'])
  const ask = events(posts).find(e => e.type === 'ask')
  expect(ask).toMatchObject({ command: 'git push origin main', cwd: '/data/workspace' })
  expect(String(ask?.reason)).toContain('main')
  expect(polls).toHaveLength(2)
  expect(polls[0]).toBe(`${URL}/asks/${ask?.askId}?wait=25`)
  expect(events(posts).some(e => e.type === 'guard')).toBe(false)
})

test('a push to main a person edited runs as they edited it', async ($, on) => {
  const { ran, commands } = world(on, [{ decision: 'approved', by: 'ann@example.com', command: 'git push origin fix/alerts' }])
  await $.session.start({ cwd: '/data/workspace', surface: 'terminal', isInteractive: false })
  await $.prompt.submit({ text: `<!-- landflow-trace ${URL} -->\nShip it` })
  const result = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'turn-1', reason: 'answer' })

  expect(result.deny).toBeUndefined()
  expect(ran).toEqual(['Bash'])
  expect(commands).toEqual(['git push origin fix/alerts'])
})

test('a push to main a person denies is refused with their word', async ($, on) => {
  const { posts, ran } = world(on, [{ decision: 'denied', by: 'ann@example.com' }])
  await $.session.start({ cwd: '/data/workspace', surface: 'terminal', isInteractive: false })
  await $.prompt.submit({ text: `<!-- landflow-trace ${URL} -->\nShip it` })
  const result = await $.tool.call({ tool: 'Bash', command: 'git add -A && git push origin main' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'turn-1', reason: 'answer' })

  expect(ran).toEqual([])
  expect(result.deny).toBe('A person denied: git add -A && git push origin main')
  expect(events(posts).filter(e => e.type === 'ask')).toHaveLength(1)
})

test('a command nobody answered in time is refused and reported', async ($, on) => {
  const { posts, ran } = world(on, [{ decision: 'denied', expired: true }])
  await $.session.start({ cwd: '/data/workspace', surface: 'terminal', isInteractive: false })
  await $.prompt.submit({ text: `<!-- landflow-trace ${URL} -->\nShip it` })
  const result = await $.tool.call({ tool: 'Bash', command: 'git push --force origin feature' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'turn-1', reason: 'answer' })

  expect(ran).toEqual([])
  expect(result.deny).toContain("Nobody answered in time, so this didn't run")
  expect(events(posts).find(e => e.type === 'guard')).toMatchObject({ rule: 'git-push', action: 'deny' })
})

test('without a trace URL a push to main is refused, nobody to ask', async ($, on) => {
  const { posts, ran } = world(on)
  await $.session.start({ cwd: '/data/workspace', surface: 'terminal', isInteractive: false })
  const result = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  expect(ran).toEqual([])
  expect(result.deny).toContain('git-push')
  expect(posts).toEqual([])
})

test('a read-only agent never asks: every push is refused', { options: { guard: 'strict' } }, async ($, on) => {
  const { posts, ran } = world(on)
  await $.session.start({ cwd: '/data/workspace', surface: 'terminal', isInteractive: false })
  await $.prompt.submit({ text: `<!-- landflow-trace ${URL} -->\nReview` })
  const result = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'turn-1', reason: 'answer' })
  expect(ran).toEqual([])
  expect(result.deny).toContain('read-only')
  expect(events(posts).some(e => e.type === 'ask')).toBe(false)
})

test('a report-only agent runs a push to main and reports it', { options: { guard: 'report' } }, async ($, on) => {
  const { posts, ran } = world(on)
  await $.session.start({ cwd: '/data/workspace', surface: 'terminal', isInteractive: false })
  await $.prompt.submit({ text: `<!-- landflow-trace ${URL} -->\nShip it` })
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'turn-1', reason: 'answer' })
  expect(ran).toEqual(['Bash'])
  expect(events(posts).some(e => e.type === 'ask')).toBe(false)
  expect(events(posts).find(e => e.type === 'guard')).toMatchObject({ rule: 'git-push', action: 'report' })
})

test('the guard enforces without a marker, and a marker can\'t loosen it', async ($, on) => {
  const { posts, ran } = world(on)
  await $.session.start({ cwd: '/data/workspace', surface: 'terminal', isInteractive: false })
  const refused = await $.tool.call({ tool: 'Read', file_path: '/data/workspace/.env' })
  expect(refused.deny).toContain('secret-file')

  await $.prompt.submit({ text: `<!-- landflow-trace ${URL} guard=report -->\nLook around` })
  const still = await $.tool.call({ tool: 'Write', file_path: '/etc/profile', content: 'x' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'turn-2', reason: 'answer' })
  expect(ran).toEqual([])
  expect(still.deny).toContain('write-outside-workspace')
  expect(events(posts)[0]).toMatchObject({ type: 'start', guard: 'enforce' })
})

test('an agent deployed with guard report only reports', { options: { guard: 'report' } }, async ($, on) => {
  const { posts, ran } = world(on)
  await $.session.start({ cwd: '/data/workspace', surface: 'terminal', isInteractive: false })
  await $.prompt.submit({ text: `<!-- landflow-trace ${URL} -->\nLook around` })
  await $.tool.call({ tool: 'Write', file_path: '/etc/profile', content: 'x' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'turn-1', reason: 'answer' })
  expect(ran).toEqual(['Write'])
  expect(events(posts).find(e => e.type === 'guard')).toMatchObject({ rule: 'write-outside-workspace', action: 'report' })
})

test('a strict agent stays read-only on the code, whatever the request says', { options: { guard: 'strict' } }, async ($, on) => {
  const { posts, ran } = world(on)
  await $.session.start({ cwd: '/data/workspace', surface: 'terminal', isInteractive: false })
  await $.prompt.submit({ text: `<!-- landflow-trace ${URL} guard=off -->\nReview the branch` })
  const edit = await $.tool.call({ tool: 'Edit', file_path: '/data/workspace/src/a.ts', old_string: 'a', new_string: 'b' })
  const commit = await $.tool.call({ tool: 'Bash', command: 'git commit -am "fix"' })
  await $.tool.call({ tool: 'Bash', command: 'pnpm install && pnpm test' })
  await $.tool.call({ tool: 'Write', file_path: '/tmp/notes.md', content: 'x' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'turn-1', reason: 'answer' })
  expect(edit.deny).toContain('read-only')
  expect(commit.deny).toContain('read-only')
  expect(ran).toEqual(['Bash', 'Write'])
  const all = events(posts)
  expect(all[0]).toMatchObject({ type: 'start', guard: 'strict' })
  expect(all.filter(e => e.type === 'guard').map(e => e.action)).toEqual(['deny', 'deny'])
})

test('a marker can make an agent stricter for one request', async ($, on) => {
  const { ran } = world(on)
  await $.session.start({ cwd: '/data/workspace', surface: 'terminal', isInteractive: false })
  await $.prompt.submit({ text: `<!-- landflow-trace ${URL} guard=strict -->\nLook only` })
  const edit = await $.tool.call({ tool: 'Write', file_path: '/data/workspace/a.ts', content: 'x' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'turn-1', reason: 'answer' })
  expect(edit.deny).toContain('read-only')
  await $.prompt.submit({ text: `<!-- landflow-trace ${URL} -->\nNow write` })
  await $.tool.call({ tool: 'Write', file_path: '/data/workspace/a.ts', content: 'x' })
  expect(ran).toEqual(['Write'])
})

test('a token in a tool result is masked before it is kept', async ($, on) => {
  world(on)
  const kept: unknown[] = []
  on('session.append', { door: 'tool-result' }, (_, e, next) => {
    kept.push(e.message.content)
    return next(e)
  })
  const token = `ghp_${'a'.repeat(36)}`
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `remote: ${token}` }] },
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Bash' },
    uuid: 'row-1',
  } as never)
  expect(JSON.stringify(kept)).not.toContain(token)
  expect(JSON.stringify(kept)).toContain('[redacted GitHub token]')
})
