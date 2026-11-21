// Tests for scripts/history-fragments.mjs, run with `node --test scripts/` on a temp docs/ tree.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { assemble, checkFragments, parseFragment } from './history-fragments.mjs'

const HISTORY = `# Build history

## 2026-11-14: Landledger

| Commit | What it built | Documented in |
|---|---|---|
| \`b6f6f1c\` | First row | [a](a.md) |
| (this change) | Second row | |

## 2026-11-15: Later

| Commit | What it built | Documented in |
|---|---|---|
| \`1\` | Later row | |
`

function tree(t, history = HISTORY) {
  const root = mkdtempSync(join(tmpdir(), 'hist-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'history.d'))
  mkdirSync(join(root, 'reference'))
  writeFileSync(join(root, 'history.md'), history)
  writeFileSync(join(root, 'a.md'), '# a')
  writeFileSync(join(root, 'reference', 'api.md'), '# api')
  return root
}
const frag = (root, name, text) => writeFileSync(join(root, 'history.d', name), text)
const row = (t, links = '') => `| (this change) | ${t} | ${links} |`

test('no fragments passes; README.md is skipped', (t) => {
  const root = tree(t)
  assert.deepEqual(checkFragments(root), [])
  frag(root, 'README.md', 'anything at all')
  assert.deepEqual(checkFragments(root), [])
})

test('dotfiles and subfolders in history.d are ignored; absolute and folder link targets fail', (t) => {
  const root = tree(t)
  frag(root, '.DS_Store', 'binary junk')
  mkdirSync(join(root, 'history.d', 'old'))
  assert.deepEqual(checkFragments(root), [])
  frag(root, '2026-11-21-x.md', row('x', '[a](/a.md)') + '\n')
  assert.match(checkFragments(root)[0], /\/a\.md/)
  frag(root, '2026-11-21-x.md', row('x', '[d](reference)') + '\n')
  assert.match(checkFragments(root)[0], /reference/)
})

test('a good fragment passes', (t) => {
  const root = tree(t)
  frag(root, '2026-11-21-one.md', `section: 2026-11-21: wave\n\n${row('Did it', '[api](reference/api.md#x)')}\n`)
  assert.deepEqual(checkFragments(root), [])
})

test('a bad name fails naming the file', (t) => {
  const root = tree(t)
  frag(root, '2026-11-21-Bad_Name.md', row('x') + '\n')
  const p = checkFragments(root)
  assert.equal(p.length, 1)
  assert.match(p[0], /2026-11-21-Bad_Name\.md/)
})

test('a slug over 60 characters fails', (t) => {
  const root = tree(t)
  frag(root, `2026-11-21-${'a'.repeat(61)}.md`, row('x') + '\n')
  assert.equal(checkFragments(root).length, 1)
})

test('an empty section line fails', (t) => {
  const root = tree(t)
  frag(root, '2026-11-21-x.md', `section:   \n${row('x')}\n`)
  assert.match(checkFragments(root)[0], /section/)
})

test('a two-cell row fails with its line number', (t) => {
  const root = tree(t)
  frag(root, '2026-11-21-x.md', `section: s\n${row('ok')}\n| (this change) | only two |\n`)
  const p = checkFragments(root)
  assert.equal(p.length, 1)
  assert.match(p[0], /2026-11-21-x\.md:3:/)
})

test('a line that is not a row fails; a fragment with no rows fails', (t) => {
  const root = tree(t)
  frag(root, '2026-11-21-x.md', `hello\n${row('ok')}\n`)
  assert.match(checkFragments(root)[0], /x\.md:1:/)
  frag(root, '2026-11-21-x.md', `section: s\n`)
  assert.match(checkFragments(root)[0], /no rows/)
})

test('a first cell other than (this change) fails', (t) => {
  const root = tree(t)
  frag(root, '2026-11-21-x.md', '| `abc` | text | |\n')
  assert.match(checkFragments(root)[0], /\(this change\)/)
})

test('a link to a missing file fails naming the fragment and the file', (t) => {
  const root = tree(t)
  frag(root, '2026-11-21-x.md', row('x', '[api](reference/apy.md)') + '\n')
  const p = checkFragments(root)
  assert.match(p[0], /2026-11-21-x\.md:1:/)
  assert.match(p[0], /reference\/apy\.md/)
})

test('angle-bracket targets resolve whole, anchors are stripped, URLs are not checked', (t) => {
  const root = tree(t)
  writeFileSync(join(root, 'A B.md'), '# ab')
  frag(root, '2026-11-21-x.md', row('x', '[x](<A B.md#y>) [w](https://example.com/nope.md) [h](#here)') + '\n')
  assert.deepEqual(checkFragments(root), [])
  frag(root, '2026-11-21-x.md', row('x', '[x](<A C.md#y>)') + '\n')
  assert.match(checkFragments(root)[0], /A C\.md/)
})

test('a row already in history.md fails and says to delete the fragment', (t) => {
  const root = tree(t)
  frag(root, '2026-11-21-x.md', '| (this change) | Second row | |\n')
  assert.match(checkFragments(root)[0], /already assembled: delete the fragment/)
})

test('an escaped pipe stays inside one cell', (t) => {
  const parsed = parseFragment('2026-11-21-x.md', '| (this change) | a \\| b | |\n')
  assert.deepEqual(parsed.problems, [])
  assert.equal(parsed.rows.length, 1)
  const root = tree(t)
  frag(root, '2026-11-21-x.md', '| (this change) | a \\| b | |\n')
  assert.deepEqual(checkFragments(root), [])
})

test('two fragments append under the last section in file-name order and are deleted', (t) => {
  const root = tree(t)
  frag(root, '2026-11-21-b.md', row('B row') + '\n')
  frag(root, '2026-11-21-a.md', row('A row') + '\n')
  assert.deepEqual(assemble(root), { rows: 2, fragments: 2 })
  const text = readFileSync(join(root, 'history.md'), 'utf8')
  assert.equal(text, HISTORY.replace('| `1` | Later row | |\n', '| `1` | Later row | |\n' + row('A row') + '\n' + row('B row') + '\n'))
  assert.deepEqual(readdirSync(join(root, 'history.d')), [])
})

test('a missing section is created with the table header', (t) => {
  const root = tree(t)
  frag(root, '2026-11-21-a.md', `section: 2026-11-21: combined wave 1\n${row('A row')}\n`)
  frag(root, '2026-11-21-b.md', `section: 2026-11-21: combined wave 1\n${row('B row')}\n`)
  assemble(root)
  const text = readFileSync(join(root, 'history.md'), 'utf8')
  assert.equal(
    text,
    HISTORY + `\n## 2026-11-21: combined wave 1\n\n| Commit | What it built | Documented in |\n|---|---|---|\n${row('A row')}\n${row('B row')}\n`,
  )
})

test('an existing named section gets the rows after its last row', (t) => {
  const root = tree(t)
  frag(root, '2026-11-21-a.md', `section: 2026-11-14: Landledger\n${row('A row')}\n`)
  assemble(root)
  const text = readFileSync(join(root, 'history.md'), 'utf8')
  assert.ok(text.includes(`| (this change) | Second row | |\n${row('A row')}\n\n## 2026-11-15`))
})

test('a second run changes nothing', (t) => {
  const root = tree(t)
  frag(root, '2026-11-21-a.md', row('A row') + '\n')
  assemble(root)
  const once = readFileSync(join(root, 'history.md'), 'utf8')
  assert.deepEqual(assemble(root), { rows: 0, fragments: 0 })
  assert.equal(readFileSync(join(root, 'history.md'), 'utf8'), once)
})

test('a row added directly to history.md and a fragment both end up once', (t) => {
  const root = tree(t, HISTORY + '| (this change) | Direct row | |\n')
  frag(root, '2026-11-21-a.md', row('A row') + '\n')
  assemble(root)
  const text = readFileSync(join(root, 'history.md'), 'utf8')
  assert.equal(text.split('Direct row').length, 2)
  assert.equal(text.split('A row').length, 2)
  assert.ok(text.endsWith(`| (this change) | Direct row | |\n${row('A row')}\n`))
})

test('a problem writes nothing and deletes nothing', (t) => {
  const root = tree(t)
  frag(root, '2026-11-21-a.md', row('A row') + '\n')
  frag(root, '2026-11-21-b.md', '| (this change) | two cells |\n')
  assert.throws(() => assemble(root), /b\.md:1/)
  assert.equal(readFileSync(join(root, 'history.md'), 'utf8'), HISTORY)
  assert.equal(readdirSync(join(root, 'history.d')).length, 2)
})

test('200 fragments assemble in under one second', (t) => {
  const root = tree(t)
  for (let i = 0; i < 200; i++) frag(root, `2026-11-21-f${String(i).padStart(3, '0')}.md`, row(`Row ${i}`, '[a](a.md)') + '\n')
  const began = Date.now()
  assert.equal(assemble(root).rows, 200)
  assert.ok(Date.now() - began < 1000)
})

test('the repository passes its own check', (t) => {
  assert.deepEqual(checkFragments(fileURLToPath(new URL('../docs', import.meta.url))), [])
  assert.ok(existsSync(new URL('../docs/history.md', import.meta.url)))
})
