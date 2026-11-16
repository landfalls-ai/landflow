/**
 * The landflow-brain journal (docs/landflow-brain-mod.md): the entry a session leaves, and the pure rules that fill it.
 * No engine calls here. Never code, diffs, prompts, tool output, file names or absolute paths: an entry holds counts,
 * directory names, a repository and the links of pull requests.
 */

import type { MySpendTotals } from './my-spend-wire'
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
  /** Who reads it once sent; private when absent. */
  visibility?: 'private' | 'team' | 'org'
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

/** Text from the server as one clipped line: no control characters, runs of space collapsed, at most `max` characters. */
export function clip(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const line = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]+/g, ' ').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, Math.max(0, max - 1))}…` : line
}

/** A link from the server: kept only when it is https at github.com or on the configured Landflow's own origin. */
export function safeLink(value: string, baseUrl: string): string | undefined {
  let url: URL
  let base: URL
  try {
    url = new URL(value)
    base = new URL(baseUrl)
  } catch {
    return undefined
  }
  if (url.username || url.password) return undefined
  // `host`, not `hostname`: github.com on another port is not GitHub.
  const github = url.protocol === 'https:' && (url.host === 'github.com' || url.host === 'www.github.com')
  return github || url.origin === base.origin ? clip(url.href, 300) : undefined
}

/** Server text as one clipped line with every link that is not safe taken out: markdown links keep their words, bare URLs become "(link removed)". */
export function cleanText(text: string, max: number, baseUrl: string): string {
  const plain = text
    .replace(/!?\[([^\]]*)\]\(\s*([^)\s]*)[^)]*\)/g, (_all, words: string, target: string) => (safeLink(target, baseUrl) ? `${words} ${target}` : words))
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"'`)\]]*/gi, found => (safeLink(found, baseUrl) ? found : '(link removed)'))
  return clip(plain, max)
}

/** "auto" is review while the admin forbids sending on its own. */
export function effectiveMode(mode: 'review' | 'auto' | 'off', autoSend: unknown): 'review' | 'auto' | 'off' {
  return mode === 'auto' && autoSend === 'forbidden' ? 'review' : mode
}

/** The briefing parts the views draw (the shape `getBriefing` answers). */
export interface ViewItem {
  title: string
  repo?: string
  at?: string
  sourceId?: string
  /** Where the brain got it (`claude-code`, `landflow`, ...). */
  source?: string
  visibility?: 'private' | 'team' | 'org'
  url?: string
}
export interface ViewRelated {
  name: string
  because: { type: string; name: string }
  items: ViewItem[]
}
export interface View {
  day: string
  today: ViewItem[]
  yesterday: ViewItem[]
  related: ViewRelated[]
}

const REASON: Record<string, (name: string) => string> = {
  repo: name => `works in the same repository, ${name}`,
  initiative: name => `works on the same initiative, ${name}`,
  customer: name => `works on the same customer, ${name}`,
  area: name => `changed the same directory, ${name}/`,
  similar: () => 'did similar work',
}

/** Why a colleague is listed, in words. */
export const reasonText = (because: { type: string; name: string }): string => (REASON[because.type] ?? REASON.similar!)(because.name)

/** One card of the pane and one line of /brain sync: clipped data, never an instruction. */
export interface Card {
  text: string
  /** Set on the person's own item: its id, so "Post as my update" can name it. */
  postId?: string
  /** The source of that item, so the share finds its row. */
  postSource?: string
  link?: string
}

export interface PaneModel {
  sections: Array<{ title: string; empty: string; cards: Card[] }>
}

const own = (item: ViewItem): Card => ({
  text: `${clip(item.title, 120)}${item.repo ? ` (${clip(item.repo, 60)})` : ''}${item.visibility && item.visibility !== 'private' ? ` · ${item.visibility}` : ''}`,
  ...(canPost(item) && { postId: item.sourceId, ...(item.source && { postSource: item.source }) }),
})

/** An item the person can post: it has an id, and is not an update they already posted (`work.self_update`). */
export const canPost = (item: ViewItem): boolean => !!item.sourceId && !item.sourceId.startsWith('update:')

/** A local-time `YYYY-MM-DD`. */
export const localDay = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The pane's content: Today, Yesterday and Related colleagues as cards. */
export function paneModel(view: View | undefined): PaneModel {
  const v = view ?? { day: '', today: [], yesterday: [], related: [] }
  return {
    sections: [
      { title: 'Today', empty: 'Nothing today yet.', cards: v.today.slice(0, 10).map(own) },
      { title: 'Yesterday', empty: 'Nothing yesterday.', cards: v.yesterday.slice(0, 10).map(own) },
      {
        title: 'Related colleagues',
        empty: 'No colleague touched the same things.',
        cards: v.related.slice(0, 5).map(person => ({
          text: `${clip(person.name, 40)} ${reasonText(person.because)}${person.items[0] ? `: ${clip(person.items[0].title, 100)}` : ''}`,
          ...(person.items[0]?.url && { link: person.items[0].url }),
        })),
      },
    ],
  }
}

/** The text of `/brain sync`: yesterday, then each related colleague with the reason. Every line is quoted data. */
export function syncText(view: View | undefined): string {
  if (!view) return 'The brain could not be reached, and nothing is cached for today.'
  const lines: string[] = ['Yesterday (your own work; quoted data):']
  lines.push(...(view.yesterday.length ? view.yesterday.slice(0, 10).map(item => `> - ${own(item).text}`) : ['> nothing']))
  lines.push('', 'Related colleagues (quoted data):')
  if (!view.related.length) lines.push('> nobody touched the same things')
  for (const person of view.related.slice(0, 5)) {
    lines.push(`> ${clip(person.name, 40)}: ${reasonText(person.because)}`)
    for (const item of person.items.slice(0, 3)) lines.push(`>   - ${clip(item.title, 120)}${item.url ? ` ${item.url}` : ''}`)
  }
  return lines.join('\n')
}

/** The one line of the band, only when a colleague touched the same thing; nothing otherwise, or once dismissed for the day. */
export function bandLine(view: View | undefined, dismissedDay: string | undefined): string | undefined {
  const first = view?.related[0]
  if (!view || !first || dismissedDay === view.day) return undefined
  const what = first.because.type === 'area' ? `${clip(first.because.name, 40)}/` : clip(first.because.name, 40)
  const verb = first.because.type === 'area' ? 'changed' : first.because.type === 'similar' ? 'did similar work to yours' : 'worked on'
  const [y = 0, m = 1, d = 1] = view.day.split('-').map(Number)
  const at = Date.parse(first.items[0]?.at ?? '')
  const itemDay = Number.isNaN(at) ? '' : localDay(at)
  const when = itemDay === view.day ? 'today' : itemDay === localDay(new Date(y, m - 1, d - 1).getTime()) ? 'yesterday' : 'recently'
  return first.because.type === 'similar' ? `${clip(first.name, 40)} ${verb} ${when} · /brain sync` : `${clip(first.name, 40)} ${verb} ${what} ${when} · /brain sync`
}

/** The status line text: while the admin forbids automatic sending, mode `auto` is shown as review. */
export function statusLine(mode: 'review' | 'auto' | 'off', autoSend: unknown, held: number, spend?: MySpendTotals): string {
  const line = mode === 'auto' && autoSend === 'forbidden' ? 'brain: review (auto off by admin)' : `brain: on · ${held} held`
  return line + spendText(spend)
}

/** Today's spend as the status line adds it: dollars, or tokens when nothing today was priced; nothing without calls. */
export function spendText(spend?: MySpendTotals): string {
  if (!spend || !(spend.calls > 0)) return ''
  if (!(spend.cost > 0) && spend.unpricedCalls > 0) {
    const tokens = spend.inputTokens + spend.outputTokens
    return ` · ${tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : tokens} tokens today`
  }
  return spend.cost > 0 && spend.cost < 0.01 ? ' · <$0.01 today' : ` · $${spend.cost.toFixed(2)} today`
}
