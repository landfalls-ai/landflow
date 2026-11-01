// `claude plugin test apps/web/claude-plugins/landflow-harness`: the hooks against the engine's own test kit. The rules
// themselves are tested in Landflow (apps/web/test/claude-harness-mod.test.ts).
import { expect, mock, test } from 'claude-code/testing'

const URL = 'http://landflow.test/api/agent-trace/t1'
const usage = { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 9000, cache_creation_input_tokens: 300, model: 'claude-sonnet-5-5' }

/** The engine beneath the mod: a network that keeps what was posted, tools that answer, a turn that ends. */
function world(on: Parameters<Parameters<typeof test>[1]>[1]) {
  const posts: Array<{ url: string; events: Array<Record<string, unknown>> }> = []
  const ran: string[] = []
  mock.clock(on, { now: 1000 })
  mock.env(on, { HOME: '/data' })
  on('http.fetch', (_, e) => {
    posts.push({ url: e.url, events: JSON.parse(e.init?.body ?? '{}').events })
    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', (_, e) => {
    ran.push(e.tool)
    return { result: {} }
  })
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'Bash', input: {} }], stopReason: 'tool_use' as const, usage }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return { posts, ran }
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

test('the guard refuses a push to main and tells the run', async ($, on) => {
  const { posts, ran } = world(on)
  await $.session.start({ cwd: '/data/workspace', surface: 'terminal', isInteractive: false })
  await $.prompt.submit({ text: `<!-- landflow-trace ${URL} -->\nShip it` })
  const result = await $.tool.call({ tool: 'Bash', command: 'git add -A && git push origin main' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'turn-1', reason: 'answer' })

  expect(ran).toEqual([])
  expect(result.deny).toContain('git-push')
  expect(events(posts).find(e => e.type === 'guard')).toMatchObject({ rule: 'git-push', tool: 'Bash', action: 'deny' })
})

test('the guard enforces without a marker, and guard=report only reports', async ($, on) => {
  const { posts, ran } = world(on)
  await $.session.start({ cwd: '/data/workspace', surface: 'terminal', isInteractive: false })
  const refused = await $.tool.call({ tool: 'Read', file_path: '/data/workspace/.env' })
  expect(refused.deny).toContain('secret-file')

  await $.prompt.submit({ text: `<!-- landflow-trace ${URL} guard=report -->\nLook around` })
  await $.tool.call({ tool: 'Write', file_path: '/etc/profile', content: 'x' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'turn-2', reason: 'answer' })
  expect(ran).toEqual(['Write'])
  expect(events(posts).find(e => e.type === 'guard')).toMatchObject({ rule: 'write-outside-workspace', action: 'report' })
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
