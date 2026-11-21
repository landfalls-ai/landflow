// Changelog fragments: each change writes its history rows to docs/history.d/<yyyy-mm-dd>-<slug>.md instead of editing
// docs/history.md, so parallel branches never conflict there. The integrator moves them in once per wave.
//
//   node scripts/history-fragments.mjs --check      exit 1 with "<file>:<line>: <problem>" lines
//   node scripts/history-fragments.mjs --assemble   append every fragment's rows to docs/history.md, delete the fragments
//
// Format: docs/history.d/README.md describes it; docs/development.md#history-fragments says when each command runs.
import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/
const MAX_SLUG = 60
const FIRST_CELL = '(this change)'
const TABLE_HEADER = ['| Commit | What it built | Documented in |', '|---|---|---|']

/** Splits a table row into cells on unescaped pipes; null when it is not a row. */
function splitRow(line) {
  const t = line.trim()
  if (!t.startsWith('|') || !t.endsWith('|') || t.length < 2) return null
  const cells = []
  let cur = ''
  for (let i = 1; i < t.length - 1; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') {
      cur += '\\|'
      i++
    } else if (t[i] === '|') {
      cells.push(cur.trim())
      cur = ''
    } else cur += t[i]
  }
  cells.push(cur.trim())
  return cells
}

/** The Markdown link targets of a row, anchors stripped; URLs and bare anchors are left out. */
function linkTargets(text) {
  const out = []
  for (const m of text.matchAll(/\]\((<[^>]*>|[^)\s]*)[^)]*\)/g)) {
    let target = m[1].startsWith('<') ? m[1].slice(1, -1) : m[1]
    target = target.split('#')[0]
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue
    out.push(target)
  }
  return out
}

/** True when a relative link target is an existing file; absolute targets never count. */
function isFileUnder(docsDir, target) {
  if (target.startsWith('/')) return false
  const p = resolve(docsDir, target)
  return existsSync(p) && statSync(p).isFile()
}

/** Parses one fragment: { section?, rows: [{ line, text }], problems }. Problems carry "<name>:<line>: ...". */
export function parseFragment(name, text) {
  const problems = []
  const rows = []
  let section
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim()
    const at = `${name}:${i + 1}`
    if (!line) return
    if (i === 0 && /^section:/i.test(line)) {
      section = line.replace(/^section:/i, '').trim()
      if (!section) problems.push(`${at}: "section:" needs a heading text`)
      return
    }
    const cells = splitRow(line)
    if (!cells) return problems.push(`${at}: not a table row (a fragment holds only an optional first "section:" line and rows)`)
    if (cells.length !== 3) return problems.push(`${at}: a row needs exactly three columns, found ${cells.length}`)
    if (cells[0] !== FIRST_CELL) problems.push(`${at}: the first column must be ${FIRST_CELL}`)
    rows.push({ line: i + 1, text: line })
  })
  if (rows.length === 0 && problems.length === 0) problems.push(`${name}: no rows`)
  return { section, rows, problems }
}

function listFragments(docsDir) {
  const dir = join(docsDir, 'history.d')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f !== 'README.md' && !f.startsWith('.') && statSync(join(dir, f)).isFile())
    .sort()
}

function nameProblem(f) {
  if (!NAME.test(f)) return `${f}: name must be <yyyy-mm-dd>-<slug>.md (lowercase letters, digits and dashes)`
  if (f.length - '.md'.length - 11 > MAX_SLUG) return `${f}: the slug is longer than ${MAX_SLUG} characters`
  return null
}

/** Reads and validates every fragment: { parsed: Map name -> fragment, problems, history }. */
function load(docsDir) {
  const historyPath = join(docsDir, 'history.md')
  const history = existsSync(historyPath) ? readFileSync(historyPath, 'utf8') : ''
  const present = new Set(history.split('\n').map((l) => l.trim()))
  const parsed = new Map()
  const problems = []
  for (const f of listFragments(docsDir)) {
    const bad = nameProblem(f)
    if (bad) {
      problems.push(bad)
      continue
    }
    const frag = parseFragment(f, readFileSync(join(docsDir, 'history.d', f), 'utf8'))
    problems.push(...frag.problems)
    for (const r of frag.rows) {
      for (const target of linkTargets(r.text)) {
        if (!isFileUnder(docsDir, target)) problems.push(`${f}:${r.line}: link target not found under docs/: ${target}`)
      }
      if (present.has(r.text)) problems.push(`${f}:${r.line}: already assembled: delete the fragment`)
    }
    parsed.set(f, frag)
  }
  return { parsed, problems, history }
}

/** Every problem of every fragment in `<docsDir>/history.d`; empty when all is well. */
export function checkFragments(docsDir) {
  return load(docsDir).problems
}

/** Appends every fragment's rows to history.md in file-name order, then deletes the fragments. Throws on a problem. */
export function assemble(docsDir) {
  const { parsed, problems, history } = load(docsDir)
  if (problems.length) throw new Error(problems.join('\n'))
  if (parsed.size === 0) return { rows: 0, fragments: 0 }
  const lines = history.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  let count = 0
  for (const [name, frag] of parsed) {
    let start = -1
    if (frag.section) start = lines.findIndex((l) => l.trim() === `## ${frag.section}`)
    else {
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].startsWith('## ')) {
          start = i
          break
        }
      }
      if (start < 0) throw new Error(`${name}: no "section:" line and docs/history.md has no "## " section`)
    }
    if (start < 0) {
      lines.push('', `## ${frag.section}`, '', ...TABLE_HEADER)
      start = lines.length - 4
    }
    let end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
    if (end < 0) end = lines.length
    let last = start
    for (let i = start + 1; i < end; i++) if (lines[i].trim().startsWith('|')) last = i
    lines.splice(last + 1, 0, ...frag.rows.map((r) => r.text))
    count += frag.rows.length
  }
  const out = join(docsDir, 'history.md')
  writeFileSync(`${out}.tmp`, lines.join('\n') + '\n')
  renameSync(`${out}.tmp`, out)
  for (const name of parsed.keys()) unlinkSync(join(docsDir, 'history.d', name))
  return { rows: count, fragments: parsed.size }
}

function main() {
  const docsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs')
  const mode = process.argv[2]
  const show = (text) => console.error(text.split('\n').map((p) => `docs/history.d/${p}`).join('\n'))
  if (mode === '--check') {
    const problems = checkFragments(docsDir)
    if (problems.length) {
      show(problems.join('\n'))
      process.exit(1)
    }
    console.log(`history fragments ok (${listFragments(docsDir).length})`)
  } else if (mode === '--assemble') {
    try {
      const { rows, fragments } = assemble(docsDir)
      console.log(`assembled ${rows} row(s) from ${fragments} fragment(s)`)
    } catch (e) {
      show(e.message)
      process.exit(1)
    }
  } else {
    console.error('usage: node scripts/history-fragments.mjs --check | --assemble')
    process.exit(2)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
