/**
 * Practices in the mod (docs/landflow-brain-mod.md#practices): pure rules for the session section, the learn prompt and
 * cleaning what the server answers. The mod never imports Landflow; the shapes it reads are declared here.
 */
import { clip } from './journal'

/** The most characters of the session section (the server cuts to the same size; this cuts again if a server sends more). */
export const PRACTICE_BUDGET_MOD = 2000
/** Practices to draft in one `/brain learn`. */
export const LEARN_MAX_DRAFTS = 10
export const PRACTICE_SUMMARY_MAX = 300
export const PRACTICE_BODY_MAX = 4000
export const SECTION_PRACTICES = 'landflow-brain:practices'

/** What `GET /api/practices/applicable` answers, the parts the mod reads. */
export interface ApplicableAnswer {
  practices?: Array<{ handle?: unknown; version?: unknown }>
  text?: unknown
}

/** Control and invisible characters (not the line break or tab), which a rule has no use for. */
const hidden = (c: number) => (c < 32 && c !== 10 && c !== 9) || (c >= 127 && c <= 159) || c === 0x2028 || c === 0x2029 || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2064) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff

/** Control characters out, line breaks kept; cut at a line when over the budget. */
export function sectionText(answer: ApplicableAnswer | undefined, budget = PRACTICE_BUDGET_MOD): string | undefined {
  const raw = typeof answer?.text === 'string' ? answer.text : ''
  const text = [...raw.replace(/\r\n?/g, '\n')].filter(char => !hidden(char.charCodeAt(0))).join('').trim()
  if (!text) return undefined
  if (text.length <= budget) return text
  const cut = text.slice(0, budget)
  const at = cut.lastIndexOf('\n')
  return (at > budget / 2 ? cut.slice(0, at) : cut.slice(0, budget - 1) + '…').trimEnd()
}

/** The query string of `applicable`: only what is given. */
export function applicableQuery(input: { repo?: string; path?: string; topic?: string; size?: 'mod' | 'full' | 'index' }): string {
  const params = new URLSearchParams()
  if (input.repo) params.set('repo', input.repo)
  if (input.path) params.set('path', input.path)
  if (input.topic) params.set('topic', input.topic)
  params.set('size', input.size ?? 'mod')
  return params.toString()
}

const word = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/g, ' ').trim().slice(0, max)
  return text || undefined
}

/** The `practices` tool's input: a repository-relative path, a topic tag or a handle, each cleaned. */
export function practicesInput(input: unknown): { path?: string; topic?: string; handle?: string } {
  const raw = (input ?? {}) as Record<string, unknown>
  const path = word(raw.path, 300)
  const topic = word(raw.topic, 40)?.toLowerCase()
  const handle = word(raw.handle, 100)?.toLowerCase()
  return { ...(path && { path }), ...(topic && { topic }), ...(handle && { handle }) }
}

const list = (value: unknown, max: number, each: number): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim().slice(0, each)).filter(Boolean).slice(0, max) : [])

/** A draft from the model's tool input, in the shape POST /api/practices takes; the server validates the rest. */
export function draftBody(input: unknown): Record<string, unknown> {
  const raw = (input ?? {}) as Record<string, unknown>
  const projectId = word(raw.projectId, 100)
  const citations = (Array.isArray(raw.citations) ? raw.citations : [])
    .slice(0, 20)
    .map(item => {
      const c = (item ?? {}) as Record<string, unknown>
      const lines = Array.isArray(c.lines) && c.lines.length === 2 && c.lines.every(n => Number.isInteger(n) && (n as number) > 0) ? (c.lines as [number, number]) : undefined
      return { repo: word(c.repo, 201) ?? '', sha: word(c.sha, 40) ?? '', path: word(c.path, 300) ?? '', ...(lines && { lines }), excerpt: typeof c.excerpt === 'string' ? c.excerpt.slice(0, 200) : '' }
    })
    .filter(c => c.repo && c.sha && c.path && c.excerpt)
  return {
    handle: word(raw.handle, 100)?.toLowerCase() ?? '',
    title: word(raw.title, 160) ?? '',
    level: raw.level === 'project' ? 'project' : 'org',
    ...(projectId && { projectId }),
    strength: raw.strength === 'required' ? 'required' : 'recommended',
    topics: list(raw.topics, 10, 40).map(t => t.toLowerCase()),
    repos: list(raw.repos, 20, 201),
    paths: list(raw.paths, 20, 200),
    summary: word(raw.summary, PRACTICE_SUMMARY_MAX) ?? '',
    body: typeof raw.body === 'string' ? raw.body.trim().slice(0, PRACTICE_BODY_MAX) : '',
    ...(Array.isArray(raw.checks) && raw.checks.length && { checks: raw.checks.slice(0, 20) }),
    ...(citations.length && { citations }),
  }
}

/** One approved practice, as the `practices` tool shows it for a handle (the shape of `GET /api/practices/resolve`'s `practice`). */
export function practiceText(view: { handle?: unknown; title?: unknown; strength?: unknown; version?: unknown; body?: unknown; checks?: unknown }): string {
  const lines = [`[${String(view.handle)}@${String(view.version ?? '?')}] ${String(view.strength ?? '')}: ${clip(String(view.title ?? ''), 160)}`]
  if (typeof view.body === 'string') lines.push('', view.body.slice(0, PRACTICE_BODY_MAX))
  const checks = Array.isArray(view.checks) ? view.checks : []
  if (checks.length) lines.push('', 'Machine checks:', ...checks.slice(0, 20).map(check => `- ${JSON.stringify(check).slice(0, 300)}`))
  return lines.join('\n')
}

/** The paths `/brain learn` reads when none is named. */
export const LEARN_DEFAULT_PATHS = ['CLAUDE.md', 'deploy/'] as const

/**
 * The prompt `/brain learn` hands to Claude: read these places in the checkout and draft practices with `practice_draft`,
 * each citing the file at this commit with a verbatim excerpt. Citations are never verified here (docs/limitations.md).
 */
export function learnPrompt(repo: string, sha: string, paths: readonly string[]): string {
  const where = paths.length ? paths.join(', ') : `${LEARN_DEFAULT_PATHS.join(', ')} and the configuration loaders you find`
  return [
    `Read this repository (${repo}, commit ${sha}) and draft the practices a new engineer here should follow, for the company brain.`,
    `Read: ${where}.`,
    `Draft at most ${LEARN_MAX_DRAFTS} practices with the practice_draft tool, one call each. A practice is one rule people follow, written plainly: a handle like "helm/chart-location", a title, a one-line summary, and a short body. Set repos to ["${repo}"] and paths to the files it covers.`,
    `Every practice cites where you read it: citations [{ repo: "${repo}", sha: "${sha}", path, lines: [first, last], excerpt }], with the excerpt copied verbatim from the file (at most 200 characters). Never invent a rule the files do not state.`,
    'A person approves each draft on /brain, under Practices; you only draft. When you are done, say what you drafted, one line each, and what you skipped.',
  ].join('\n')
}
