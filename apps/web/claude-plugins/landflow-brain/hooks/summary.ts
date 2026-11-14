/**
 * The summary of a session (docs/landflow-brain-mod.md): deterministic rules on this machine, no model call. The title is
 * the first sentence of the first prompt with secrets masked and file paths reduced to their directories. Everything
 * else is facts: counts, directories, the repository. Never code, diffs, prompts beyond the title, tool output or the
 * environment.
 *
 * The event is the shape of `WorkEventInput` (packages/protocol/src/work-events.ts), kept by copy: the mod is installed
 * on its own.
 */
import { LIMITS, type Entry } from './journal'

/** Tokens and keys as their issuers write them (copied from landflow-harness's rules.ts). */
const SECRETS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, 'private key'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/g, 'GitHub token'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, 'GitHub token'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, 'Anthropic key'],
  [/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g, 'OpenAI key'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 'AWS access key'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, 'Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'Google API key'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, 'npm token'],
  [/\blfk_[A-Za-z0-9_-]{20,}/g, 'Landflow agent token'],
  [/\blf_[A-Za-z0-9_-]{24,}/g, 'Landflow API key'],
  [/\b(authorization:\s*(?:bearer|basic|token)\s+)[A-Za-z0-9._~+/=-]{16,}/gi, 'credential'],
  [/(:\/\/[^\s:/@]+:)[^\s@/]{6,}(@)/g, 'password'],
]

/** The text with every secret it shows masked. */
export function redact(text: string): string {
  let out = text
  for (const [pattern, name] of SECRETS) {
    out = out.replace(pattern, (match, ...groups) => {
      const keep = typeof groups[0] === 'string' && match.startsWith(groups[0]) ? groups[0] : ''
      const tail = name === 'password' && typeof groups[1] === 'string' ? groups[1] : ''
      return `${keep}[redacted ${name}]${tail}`
    })
  }
  return out
}

const FALLBACK = 'Coding session'
const looksLikeCode = (text: string) => [/[{}]/, /;\s*\S/, /=>/, /\(\s*\)/, /\b(?:function|const|let|var|import|return|class)\b\s*[\w({[]/].filter(re => re.test(text)).length >= 2

/** A path-like word reduced to its directory (two levels at most), or nothing for a bare file or an absolute path's root. */
function pathToArea(word: string): string {
  const clean = word.replace(/^[("'`]+|[)"'`,.:;!?]+$/g, '')
  const dirs = clean.replace(/\\/g, '/').split('/').filter(part => part && part !== '.' && part !== '..' && part !== '~').slice(0, -1)
  const shown = dirs.slice(-2).join('/')
  return shown && !shown.includes(',') ? shown : ''
}

/** The words of `text` with every file path reduced to its directory and every URL and email dropped. */
function withoutPaths(text: string): string {
  return text
    .split(/\s+/)
    .map(word => {
      if (/^[("'`]*https?:\/\//i.test(word) || /@[\w-]+\.[\w.-]+/.test(word)) return ''
      if (word.includes('/') || /^[("'`]*[\w-]+\.[A-Za-z][A-Za-z0-9]{0,7}[)"'`,.:;!?]*$/.test(word)) return pathToArea(word)
      return word
    })
    .filter(Boolean)
    .join(' ')
}

/** The title of a session from its first prompt: the first sentence, masked, paths as directories, at most 200 characters. */
export function titleFrom(prompt: string | undefined): string {
  if (!prompt) return FALLBACK
  // Code a person pasted is not a title: keep what comes before the first fence.
  const text = redact(prompt.split('```')[0] ?? '').replace(/\s+/g, ' ').trim()
  const sentence = /^(.+?[.!?])(\s|$)/.exec(text)?.[1] ?? text
  const title = withoutPaths(sentence).replace(/\s+/g, ' ').trim()
  if (!title || looksLikeCode(title)) return FALLBACK
  return title.length > LIMITS.title ? `${title.slice(0, LIMITS.title - 1).trimEnd()}…` : title
}

/** A work event as POST /api/brain/work takes it. */
export interface BrainWorkEvent {
  kind: 'work.session'
  source: 'claude-code'
  sourceId: string
  occurredAt: string
  endedAt?: string
  title: string
  summary: string
  repo: string
  branch?: string
  areas?: string[]
  commits: number
  prs?: Array<{ url: string; state: 'opened' | 'merged' }>
  turns: number
  visibility: 'private'
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/** The facts of an entry in one line (at most 500 characters). */
export function summaryOf(entry: Entry): string {
  const parts = [plural(entry.turns, 'turn')]
  if (entry.commits) parts.push(plural(entry.commits, 'commit'))
  if (entry.prs.length) parts.push(plural(entry.prs.length, 'pull request'))
  const line = `${parts.join(', ')} in ${entry.repo}`
  return (entry.areas.length ? `${line}; ${entry.areas.slice(0, 8).join(', ')}` : line).slice(0, 500)
}

/** The event an entry is sent as: private, whatever else. */
export function toEvent(entry: Entry): BrainWorkEvent {
  return {
    kind: 'work.session',
    source: 'claude-code',
    sourceId: entry.sourceId,
    occurredAt: entry.startedAt,
    ...(entry.endedAt && { endedAt: entry.endedAt }),
    title: entry.title.slice(0, LIMITS.title),
    summary: summaryOf(entry),
    repo: entry.repo,
    ...(entry.branch && { branch: entry.branch }),
    ...(entry.areas.length && { areas: entry.areas.slice(0, LIMITS.areas) }),
    commits: entry.commits,
    ...(entry.prs.length && { prs: entry.prs.slice(0, LIMITS.prs).map(pr => ({ url: pr.url, state: pr.state })) }),
    turns: entry.turns,
    visibility: 'private',
  }
}
