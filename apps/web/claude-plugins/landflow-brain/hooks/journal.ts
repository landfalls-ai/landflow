/**
 * The landflow-brain journal (docs/landflow-brain-mod.md): the entry a session leaves, and the pure rules that fill it.
 * No engine calls here. Never code, diffs, prompts, tool output, file names or absolute paths: an entry holds counts,
 * directory names, a repository and the links of pull requests.
 */

import type { BrainWorkEvent } from './summary'

/** `forgetting`: dropped here, but the delete in the brain has not been answered yet. */
export type EntryStatus = 'open' | 'held' | 'sent' | 'dropped' | 'forgetting'

export interface EntryPr {
  url: string
  state: 'opened' | 'merged'
}

export interface Entry {
  id: string
  source: 'claude-code'
  /** The session's id. */
  sourceId: string
  repo: string
  branch?: string
  startedAt: string
  endedAt?: string
  turns: number
  /** At most 200 characters, from the first prompt, by rules on this machine. */
  title: string
  /** Directories only, at most 20. */
  areas: string[]
  commits: number
  prs: EntryPr[]
  status: EntryStatus
  sentAt?: string
  /** Exactly what went to the brain. */
  sentEvent?: BrainWorkEvent
}

export const LIMITS = { title: 200, areas: 20, area: 80, prs: 10 } as const

/** A file name with an extension (`app.ts`), as the host refuses it in an area. */
const hasExtension = (text: string): boolean => /[^./\\]\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(text.split(/[\\/]/).pop() ?? '')

/**
 * The directory of `path` inside the repository at `repoRoot`: never the file's name, never an absolute path. Two levels
 * at most (`apps/web`). A file in the root is `.`; a path outside the repository is nothing.
 */
export function areaOf(path: string, repoRoot: string): string | undefined {
  const norm = (value: string) => {
    const out: string[] = []
    for (const part of value.replace(/\\/g, '/').split('/')) {
      if (!part || part === '.') continue
      if (part === '..') out.pop()
      else out.push(part)
    }
    return out
  }
  const root = norm(repoRoot)
  const abs = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
  const parts = abs ? norm(path) : [...root, ...norm(path)]
  if (parts.length <= root.length || root.some((part, index) => parts[index] !== part)) return undefined
  const dirs = parts.slice(root.length, -1)
  if (!dirs.length) return '.'
  const area = dirs
    .slice(0, 2)
    .filter(part => !part.includes(',') && !hasExtension(part))
    .join('/')
  return area && area.length <= LIMITS.area ? area : undefined
}

/** `owner/name` from a git remote URL (https or ssh form), or nothing. */
export function repoSlug(remote: string): string | undefined {
  const text = remote.trim()
  const found = /^(?:[a-z+]+:\/\/(?:[^@/]+@)?[^/:]+(?::\d+)?\/|[^@/\s]+@[^:/\s]+:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(text)
  return found ? `${found[1]}/${found[2]}` : undefined
}

/** The allow-list from the option: `owner/name` names separated by commas, spaces or lines. */
export function parseRepos(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value
    .split(/[\s,]+/)
    .map(part => part.trim().toLowerCase())
    .filter(part => /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(part))
}

/** Only an allowed repository is recorded. An empty list allows none. */
export const isAllowed = (allowed: readonly string[], slug: string | undefined): slug is string => !!slug && allowed.includes(slug.toLowerCase())

const PR_URL = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g

export interface BashFacts {
  commits: number
  prs: EntryPr[]
}

/**
 * What a Bash command did, as far as a work summary cares: `git commit` that printed its `[branch hash]` line, `gh pr create` and
 * `gh pr merge` with their URLs (github.com only). A push records nothing. `output` is read for the URL and then dropped.
 */
export function bashFacts(command: string, output: string, failed = false): BashFacts {
  const facts: BashFacts = { commits: 0, prs: [] }
  if (failed) return facts
  for (const part of command.split(/&&|\|\||;|\n/)) {
    const words = part.trim().split(/\s+/)
    // The command itself, after any `NAME=value` words: `echo git commit` is not a commit.
    const at = words.findIndex(word => !/^\w+=/.test(word))
    if (at < 0 || (words[at] !== 'git' && words[at] !== 'gh')) continue
    const rest: string[] = [words[at]!]
    for (let i = at + 1; i < words.length; i++) {
      const word = words[i]!
      // `git -C dir commit`: the flag's value is not the subcommand.
      if (words[at] === 'git' && /^(-C|-c|--git-dir|--work-tree|--namespace)$/.test(word)) i += 1
      else if (!word.startsWith('-') || word === '--') rest.push(word)
    }
    if (words[at] === 'git' && rest[1] === 'commit') {
      // A commit that worked prints `[branch abc1234] message`; no output, no commit.
      if (/^\s*\[[^\]]+\]/m.test(output) && !/nothing to commit|no changes added/i.test(output)) facts.commits += 1
    } else if (words[at] === 'gh' && rest[1] === 'pr' && (rest[2] === 'create' || rest[2] === 'merge')) {
      const state = rest[2] === 'create' ? 'opened' : 'merged'
      const fromCommand = part.match(PR_URL)?.[0]
      const url = output.match(PR_URL)?.[0] ?? fromCommand
      if (url) facts.prs.push({ url, state })
    }
  }
  return facts
}

/** The same URL once, with `merged` winning over `opened`; at most 10. */
export function addPrs(prs: readonly EntryPr[], more: readonly EntryPr[]): EntryPr[] {
  const out = [...prs]
  for (const pr of more) {
    const have = out.find(item => item.url === pr.url)
    if (!have) out.push({ ...pr })
    else if (pr.state === 'merged') have.state = 'merged'
  }
  return out.slice(0, LIMITS.prs)
}

/** Add directories to an entry's areas: unique, at most 20. */
export function addArea(areas: readonly string[], area: string | undefined): string[] {
  if (!area || areas.includes(area) || areas.length >= LIMITS.areas) return [...areas]
  return [...areas, area]
}

export function newEntry(input: { id: string; sourceId: string; repo: string; branch?: string; now: number }): Entry {
  return {
    id: input.id,
    source: 'claude-code',
    sourceId: input.sourceId,
    repo: input.repo,
    ...(input.branch && { branch: input.branch.slice(0, 120) }),
    startedAt: new Date(input.now).toISOString(),
    turns: 0,
    title: 'Coding session',
    areas: [],
    commits: 0,
    prs: [],
    status: 'open',
  }
}
