/**
 * The summary of a session (docs/landflow-brain-mod.md): deterministic rules on this machine, no model call. The title is
 * the first sentence of the first prompt with secrets masked and file paths reduced to their directories (absolute paths dropped). Everything
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

/** A relative path-like word reduced to its first two directories, or nothing for a bare file. */
function pathToArea(word: string): string {
  const dirs = word.split('/').filter(part => part && part !== '.' && part !== '..').slice(0, -1)
  const shown = dirs.slice(0, 2).join('/')
  return shown && !shown.includes(',') ? shown : ''
}

/** An absolute or home path, a drive path or a backslash path: dropped whole, so no directory of the machine leaves it. */
const isMachinePath = (word: string) => /^[/~]/.test(word) || /^[A-Za-z]:[\\/]/.test(word) || word.includes('\\') || /^\$\{?(?:HOME|PWD)\b/.test(word)

/** A machine path after a prefix (`@/Users/x`, `--dir=/Users/x`, `path=~/x`, `file:///x`, `(/x`), or a path that climbs out with `..`. */
const isPrefixedMachinePath = (word: string) => /(^|[=@:(])(~|\/|[A-Za-z]:[\\/])/.test(word) || /^file:/i.test(word) || word.split(/[\\/]/).includes('..')

/** A word without the brackets, quotes and punctuation around it. */
const bareOf = (word: string) => word.replace(/^[("'`<\[“‘]+|[)"'`>\],.:;!?”’]+$/g, '')
const isAnyMachinePath = (word: string) => isMachinePath(word) || isPrefixedMachinePath(word)

/** A quoted span ("…", '…', `…`, “…”, ‘…’), closed or running to the end; a `'` inside a word (`don't`) neither opens nor closes one. */
const QUOTED = /"[^"]*(?:"|$)|`[^`]*(?:`|$)|“[^”]*(?:”|$)|‘[^’]*(?:’|$)|(?<!\w)'(?:[^']|'(?=\w))*(?:'(?!\w)|$)/g

/** A path whose last part is a file name (`notes.txt`): it ends there. */
const endsInFile = (path: string) => /[^./\\]\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(path.split(/[\\/]/).pop() ?? '')

/** The words of `text`: absolute paths and URLs and emails dropped, a relative file path reduced to its directories. */
function withoutPaths(text: string): string {
  // A machine path may hold spaces. A quoted span that holds one goes whole, and `\ ` stays inside its word. A bare one
  // that does not end in a file name may go on (`~/a/My Big Project/x`), so the rest of its clause goes with it, up to a
  // `.`, `,`, `;`, `:`, `!` or `?` that ends a word, or a new line; after one that ends in a file name, the words with a
  // slash that follow still go (`/Users/a/Acme.com Files/x`).
  let after: 'clause' | 'slashes' | undefined
  const parts = text.replace(QUOTED, span => (span.split(/\s+/).some(word => isAnyMachinePath(bareOf(word))) ? ' ' : span)).split(/((?<!\\)\s+)/)
  const words: string[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const word = parts[i] ?? ''
    const bare = bareOf(word)
    const clauseEnds = /[.,;:!?][)"'`>\]”’]*$/.test(word) || (parts[i + 1] ?? '').includes('\n')
    if (after === 'clause' || (after === 'slashes' && /[\\/]/.test(bare))) {
      if (after === 'clause' && clauseEnds) after = undefined
      continue
    }
    after = undefined
    if (/^https?:\/\//i.test(bare) || /@[\w-]+\.[\w.-]+/.test(bare)) continue
    if (isAnyMachinePath(bare)) {
      after = !endsInFile(bare) ? (clauseEnds ? undefined : 'clause') : 'slashes'
      continue
    }
    const slashes = bare.split('/').length - 1
    const file = /^[\w./-]*[\w-]\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(bare)
    // `and/or`, `CI/CD` and `11/12` are words; `apps/web/x` and `app.ts` are paths.
    words.push(slashes >= 2 || (slashes === 1 && file) || (slashes === 0 && file) ? pathToArea(bare) : word)
  }
  return words.filter(Boolean).join(' ')
}

/** The title of a session from its first prompt: the first sentence, masked, paths as directories, at most 200 characters. */
export function titleFrom(prompt: string | undefined): string {
  if (!prompt) return FALLBACK
  // Code a person pasted is not a title: keep what comes before the first fence.
  // New lines stay until the words are split: a line break ends a clause.
  const text = redact(prompt.split('```')[0] ?? '').replace(/[^\S\n]*\n\s*/g, '\n').replace(/[^\S\n]+/g, ' ').trim()
  const sentence = /^(.+?[.!?])(\s|$)/s.exec(text)?.[1] ?? text
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
