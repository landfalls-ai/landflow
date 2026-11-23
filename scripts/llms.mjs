#!/usr/bin/env node
// Publishes Landflow's docs to agents: docs/published.json lists what is published, this script turns it into
// docs/llms.txt (committed) and docs/llms-full.txt (built, never committed).
//   node scripts/llms.mjs --check   regenerate in memory; fail on a stale llms.txt or any problem (pnpm check:docs)
//   node scripts/llms.mjs --write   write both files (pnpm docs:llms); refuses while there are problems
// Only the manifest's pages are ever read; everything else in docs/ is internal by default. No network, no dependency,
// no clock: two runs give the same bytes. Design after dot-agent-deck's docs/published.toml (C25).
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_DOCS = 'https://github.com/landfalls-ai/landflow/blob/main/docs/'
/** Never publishable, whatever the manifest says (FR-2, AS-2): a manifest entry under one fails. */
const FIXED_INTERNAL = ['limitations.md', 'roadmap.md', 'history.md', 'history.d/', 'development.md', 'constitution.md', 'specs/', 'research/']
/**
 * A link from a published page into one of these fails the check (AS-3); a link to any other unpublished page (the
 * limitations and roadmap pages are linked everywhere) keeps its words and loses the link. The manifest's `internal`
 * list adds to it.
 */
const LINK_INTERNAL = ['specs/', 'research/', 'history.md', 'constitution.md']
/** FR-7: the caps in bytes. */
export const LIMITS = { llms: 20 * 1024, full: 1.5 * 1024 * 1024 }
/** Folders never listed as "not published": internal, or generated notes. */
const QUIET = ['specs/', 'research/', 'history.d/']

/**
 * Strings a published page must not hold (public repo): [name, pattern, allowed]. A match the optional `allowed` pattern
 * accepts is fine: the two documented development keys (deploy/.env.example), the documented placeholder passwords and the
 * host names Docker, Podman and OrbStack give the host machine.
 */
const SECRET_PATTERNS = [
  ['a home-folder path', /\/Users\/[A-Za-z0-9._-]+|\/home\/[a-z][a-z0-9._-]*\/|\/root\/[A-Za-z0-9._-]|C:\\Users\\/],
  ['a Claude session link', /Claude-Session|claude\.ai\/(?:code|share|artifact)|session_[A-Za-z0-9]{16,}/],
  ['a private key', /BEGIN [A-Z ]*PRIVATE KEY/],
  ['a secret-looking token', /AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}|\blf_[A-Za-z0-9_-]{24,}/g, /^sk-landflow-dev-(?:master|salt)-only$/],
  ['a payment, Google, Slack, Notion, Linear, GitLab or Telegram credential', /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|\bAIza[0-9A-Za-z_-]{30,}|hooks\.slack\.com\/services\/\w+|\bntn_[A-Za-z0-9]{20,}|\bsecret_[A-Za-z0-9]{30,}|\blin_(?:api|oauth)_[A-Za-z0-9]{20,}|\bglpat-[A-Za-z0-9_-]{20,}|\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/],
  ['a JSON web token', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['an AWS secret access key', /aws_secret_access_key["']?\s*[=:]\s*["']?[A-Za-z0-9/+=]{40,}/i],
  ['a password in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, /:(?:<[^>]*>|pw|pass|password|landflow-dev-only)@$/],
  ['an internal hostname', /\b(?:[a-z0-9-]+\.)+(?:internal|corp|lan|intranet)\b/gi, /^(?:host\.docker|host\.containers|host\.orb|kubernetes\.docker)\.internal$/i],
]
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g
/** Reserved for examples (RFC 2606 and 6761): the only domains an address may use. */
const RESERVED_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|test|example|invalid|localhost)$/i

const slugOf = (path) => path.replace(/[/.]/g, '-').toLowerCase()
/** GitHub's heading slug, so a heading keeps the anchor people already link to. */
function headingSlug(text) {
  return text
    .replace(/`/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '')
    .replace(/ /g, '-')
}

/** Every file under dir as docs-relative POSIX paths, in sorted order. */
function walk(dir, base = '') {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const rel = base ? `${base}/${name}` : name
    if (name === 'node_modules') continue
    if (statSync(join(dir, name)).isDirectory()) out.push(...walk(join(dir, name), rel))
    else out.push(rel)
  }
  return out
}

const isInternal = (path, internal) => internal.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p))

/** Marks each line as inside a code fence or not. */
function fenceMap(lines) {
  let fence = null
  return lines.map((line) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null
      return true
    }
    if (m) {
      fence = m[1]
      return true
    }
    return false
  })
}

/** Marks indented code blocks (four spaces or a tab after a blank line, not under a list item): never rewritten. */
function indentedCode(lines, fenced) {
  let inList = false
  let prevBlank = true
  let prevCode = false
  return lines.map((line, i) => {
    if (fenced[i]) {
      prevBlank = false
      prevCode = false
      return false
    }
    const blank = line.trim() === ''
    const indented = /^(?: {4}|\t)/.test(line)
    if (!blank && !indented) inList = /^\s*(?:[-*+]|\d+[.)])\s/.test(line)
    const code = indented && !inList && (prevBlank || prevCode)
    prevBlank = blank
    if (!blank) prevCode = code
    return code
  })
}

/** Headings of a page outside code fences: [{ line, level, text, slug }] with GitHub's -1, -2 suffix on repeats. */
function headings(lines) {
  const fenced = fenceMap(lines)
  const seen = new Map()
  const out = []
  lines.forEach((line, i) => {
    if (fenced[i]) return
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (!m) return
    const base = headingSlug(m[2])
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    out.push({ line: i, level: m[1].length, text: m[2], slug: n === 0 ? base : `${base}-${n}` })
  })
  return out
}

/** Reads and checks the manifest's shape; throws a plain Error when it is unusable. */
export function loadManifest(root) {
  const file = join(root, 'published.json')
  if (!existsSync(file)) throw new Error('docs/published.json is missing')
  const m = JSON.parse(readFileSync(file, 'utf8'))
  for (const key of ['title', 'summary']) if (typeof m[key] !== 'string' || !m[key]) throw new Error(`published.json: "${key}" is missing`)
  if (!Array.isArray(m.sections)) throw new Error('published.json: "sections" must be a list')
  m.internal ??= []
  return m
}

/**
 * Rewrites the links of a run of lines (FR-4, C25-D3); a link's text may wrap onto the next line. `ctx.line` is the
 * first line's number, so a problem names the page, the line and the link.
 */
function rewriteBlock(block, ctx) {
  // Inline code is left alone: swap each span for a placeholder, then put it back.
  const spans = []
  let text = block.replace(/(`+)(?:(?!\1).)+\1/g, (s) => `\u0000${spans.push(s) - 1}\u0000`)
  const link = (alt, target, image, offset = 0) => {
    const line = ctx.line + (text.slice(0, offset).match(/\n/g)?.length ?? 0)
    const href = target.trim()
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return null // an absolute URL, mailto: and the like
    const [rawPath, hash] = href.split('#')
    const anchor = hash ? decodeURIComponent(hash) : ''
    if (!rawPath) {
      const own = anchor && (ctx.headings.get(ctx.path) ?? []).find((h) => h.slug === anchor || h.slug === headingSlug(anchor))
      return { href: `#${ctx.slug}${own ? `--${own.slug}` : ''}` }
    }
    const path = posix.normalize(posix.join(posix.dirname(ctx.path), rawPath.replace(/\/$/, '')))
    if (path.startsWith('..') || path.startsWith('/')) return { text: alt } // outside docs/: the repository, not published
    if (isInternal(path, ctx.linkInternal)) {
      ctx.problems.push({ message: `docs/${ctx.path}:${line}: links to the internal page ${path} (${target})` })
      return { text: alt }
    }
    if (image) return { text: alt }
    const entry = ctx.pages.get(path)
    if (!entry) return { text: alt } // unpublished or not a page: the words without the link
    if (!entry.full) return { href: `${REPO_DOCS}${path}${hash ? `#${hash}` : ''}` }
    const heads = ctx.headings.get(path) ?? []
    const wanted = anchor && heads.find((h) => h.slug === anchor || h.slug === headingSlug(anchor))
    return { href: `#${slugOf(path)}${wanted ? `--${wanted.slug}` : ''}` }
  }
  text = text.replace(/(!?)\[((?:[^\][]|\[[^\]]*\])*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (all, bang, alt, target, offset) => {
    const r = link(alt, target, bang === '!', offset)
    if (!r) return all
    return r.text !== undefined ? r.text : `[${alt}](${r.href})`
  })
  // Reference-style definitions: `[name]: target`.
  // Footnotes (`[^n]: text`) are not definitions. A definition goes only when it pointed at a docs page that is not published.
  text = text.replace(/^([ \t]*\[(?!\^)[^\]]+\]:[ \t]*)(\S+)(.*)$/gm, (all, head, target, tail, offset) => {
    const r = link('', target, false, offset)
    if (!r) return all
    if (r.href !== undefined) return `${head}${r.href}${tail}`
    const file = target.split('#')[0]
    return file.endsWith('.md') && !posix.normalize(posix.join(posix.dirname(ctx.path), file)).startsWith('..') ? '' : all
  })
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)])
}

/** One page's text for llms-full.txt: H1 re-emitted with its anchor, inner headings anchored, links rewritten. */
function pageText(entry, source, ctx) {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const fenced = fenceMap(lines)
  const code = indentedCode(lines, fenced)
  const heads = new Map(headings(lines).map((h) => [h.line, h]))
  const slug = slugOf(entry.path)
  const out = [`<!-- page: ${entry.path} -->`, `# ${entry.title} {#${slug}}`]
  let seenH1 = false
  // Runs of lines outside code fences are rewritten together (a link's text can wrap); fenced lines pass through.
  let i = 0
  while (i < lines.length) {
    if (fenced[i] || code[i]) {
      out.push(lines[i++])
      continue
    }
    let j = i
    while (j < lines.length && !fenced[j] && !code[j]) j++
    const block = rewriteBlock(lines.slice(i, j).join('\n'), { ...ctx, path: entry.path, slug, line: i + 1 }).split('\n')
    block.forEach((text, k) => {
      const h = heads.get(i + k)
      if (h && h.level === 1 && !seenH1) {
        seenH1 = true
        return
      }
      if (!seenH1 && h === undefined && text.trim() === '') return
      out.push(h ? `${text} {#${slug}--${h.slug}}` : text)
    })
    i = j
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')
}

/** Flags what a public repo must not carry, line by line (FR-5). */
function scan(label, text, problems) {
  text.split('\n').forEach((line, i) => {
    for (const [what, pattern, allowed] of SECRET_PATTERNS) {
      const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
      if ([...line.matchAll(global)].some((m) => !allowed || !allowed.test(m[0]))) problems.push({ message: `${label}:${i + 1}: holds ${what}` })
    }
    for (const m of line.matchAll(EMAIL)) {
      if (!RESERVED_DOMAIN.test(m[1])) problems.push({ message: `${label}:${i + 1}: holds an email address (${m[0]}); use an example.com or .test one` })
    }
  })
}

/**
 * Builds both files in memory and every problem found. `notPublished` lists the docs pages outside the manifest.
 * @returns {{ llms: string, full: string, notPublished: string[], problems: { message: string }[] }}
 */
export function render(root, { limits = LIMITS } = {}) {
  const manifest = loadManifest(root)
  const problems = []
  const unpublishable = [...FIXED_INTERNAL, ...manifest.internal]
  const internal = [...LINK_INTERNAL, ...manifest.internal]
  const pages = new Map()
  const texts = new Map()
  for (const section of manifest.sections) {
    for (const page of section.pages ?? []) {
      const entry = { ...page, full: page.full === true, section: section.name }
      if (pages.has(entry.path)) {
        problems.push({ message: `published.json: ${entry.path} is listed twice` })
        continue
      }
      if (isInternal(entry.path, unpublishable)) {
        problems.push({ message: `published.json: ${entry.path} is internal and cannot be published` })
        continue
      }
      if (!entry.title || !entry.description) {
        problems.push({ message: `published.json: ${entry.path} needs a title and a description` })
        continue
      }
      const file = join(root, entry.path)
      if (!existsSync(file)) {
        problems.push({ message: `published.json: ${entry.path} is missing from docs/` })
        continue
      }
      const source = readFileSync(file, 'utf8')
      const first = headings(source.split('\n')).find((h) => h.level === 1)
      if (!first || first.text !== entry.title) {
        problems.push({ message: `published.json: the title of ${entry.path} is "${entry.title}" but its first heading is "${first ? first.text : '(none)'}"` })
      }
      pages.set(entry.path, entry)
      texts.set(entry.path, source)
    }
  }
  scan('published.json', [manifest.title, manifest.summary, ...[...pages.values()].map((p) => `${p.title} ${p.description}`)].join('\n'), problems)
  for (const [path, source] of texts) scan(`docs/${path}`, source.replace(/\r\n/g, '\n'), problems)

  const headingMap = new Map([...texts].map(([path, source]) => [path, headings(source.split('\n'))]))
  const ctx = { pages, headings: headingMap, linkInternal: internal, problems }
  const parts = [...pages.values()].filter((p) => p.full).map((p) => ({ path: p.path, text: pageText(p, texts.get(p.path), ctx) }))
  const header = `# ${manifest.title}\n\n> ${manifest.summary}\n\nThe documentation, in reading order. Each page starts with a \`<!-- page: path -->\` line.\n`
  const full = `${header}\n${parts.map((p) => p.text).join('\n\n')}\n`

  const lines = [`# ${manifest.title}`, '', `> ${manifest.summary}`]
  for (const section of manifest.sections) {
    const list = (section.pages ?? []).filter((p) => pages.has(p.path))
    if (!list.length) continue
    lines.push('', `## ${section.name}`, '')
    for (const p of list) {
      const url = p.full === true ? `/llms-full.txt#${slugOf(p.path)}` : `${REPO_DOCS}${p.path}`
      lines.push(`- [${p.title}](${url}): ${p.description}`)
    }
  }
  const llms = `${lines.join('\n')}\n`

  const bytes = (s) => Buffer.byteLength(s)
  const largest = parts.map((p) => ({ path: p.path, size: bytes(p.text) })).sort((a, b) => b.size - a.size).slice(0, 3)
  if (bytes(llms) > limits.llms) problems.push({ message: `llms.txt is ${bytes(llms)} bytes, over the ${limits.llms} limit` })
  if (bytes(full) > limits.full) {
    problems.push({
      message: `llms-full.txt is ${bytes(full)} bytes, over the ${limits.full} limit; the largest pages: ${largest.map((p) => `${p.path} (${p.size})`).join(', ')}; set "full": false on one`,
    })
  }

  const notPublished = walk(root)
    .filter((f) => f.endsWith('.md') && !pages.has(f) && !isInternal(f, internal) && !QUIET.some((q) => f.startsWith(q)))
    .sort()
  return { llms, full, notPublished, problems }
}

function main() {
  const args = process.argv.slice(2)
  const mode = args.find((a) => a === '--check' || a === '--write')
  const at = args.indexOf('--root')
  const root = at >= 0 ? args[at + 1] : join(dirname(fileURLToPath(import.meta.url)), '..', 'docs')
  if (!mode) {
    console.error('usage: llms.mjs --check | --write [--root <docs folder>]')
    process.exit(2)
  }
  let result
  try {
    result = render(root)
  } catch (e) {
    console.error(`llms: ${e.message}`)
    process.exit(1)
  }
  const problems = result.problems.map((p) => p.message)
  if (mode === '--check') {
    const committed = join(root, 'llms.txt')
    if (!existsSync(committed)) problems.push('docs/llms.txt is missing; run pnpm docs:llms')
    else if (readFileSync(committed, 'utf8') !== result.llms) problems.push('docs/llms.txt is stale; run pnpm docs:llms and commit it')
  }
  for (const p of result.notPublished) console.log(`not published: ${p}`)
  if (problems.length) {
    console.error(`llms: ${problems.length} problem${problems.length === 1 ? '' : 's'}`)
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }
  if (mode === '--write') {
    writeFileSync(join(root, 'llms.txt'), result.llms)
    writeFileSync(join(root, 'llms-full.txt'), result.full)
  }
  console.log(`llms: ok (llms.txt ${Buffer.byteLength(result.llms)} bytes, llms-full.txt ${Buffer.byteLength(result.full)} bytes)`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
