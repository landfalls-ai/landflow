// Tests for scripts/llms.mjs, run with `node --test scripts/` on a temp docs/ tree.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { render } from './llms.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'llms.mjs')

const PAGES = {
  'platform/README.md': '# Platform guide\n\nStart here. See [agents](../agents.md#knowledge-bases) and [the limits](../limitations.md).\n\n## Setup\n\nBack to [setup](#setup).\n',
  'agents.md': '# Agents\n\nText.\n\n## Knowledge bases\n\nMore. A [big page](deploy.md#x) and [code](../apps/web/src/x.ts).\n',
  'deploy.md': '# Deploy\n\nPublished, not in the full set.\n',
  'limitations.md': '# Known limitations\n\nNot published.\n',
}

const MANIFEST = {
  title: 'Landflow',
  summary: 'A workflow platform.',
  sections: [
    {
      name: 'Start here',
      pages: [
        { path: 'platform/README.md', title: 'Platform guide', description: 'The guide.', full: true },
        { path: 'agents.md', title: 'Agents', description: 'Agents.', full: true },
      ],
    },
    { name: 'Operate', pages: [{ path: 'deploy.md', title: 'Deploy', description: 'Deploying.', full: false }] },
  ],
  internal: ['notes/'],
}

function tree(t, { pages = PAGES, manifest = MANIFEST, llms } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'llms-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [path, text] of Object.entries(pages)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  writeFileSync(join(root, 'published.json'), JSON.stringify(manifest, null, 2))
  if (llms !== undefined) writeFileSync(join(root, 'llms.txt'), llms)
  return root
}

const withManifest = (change) => {
  const m = structuredClone(MANIFEST)
  change(m)
  return m
}
const problems = (root, options) => render(root, options).problems.map((p) => p.message ?? String(p))

test('llms.txt has the llmstxt.org shape and the first manifest page first (AS-1)', (t) => {
  const { llms } = render(tree(t))
  const lines = llms.split('\n')
  assert.equal(lines[0], '# Landflow')
  assert.equal(lines[2], '> A workflow platform.')
  assert.ok(llms.includes('\n## Start here\n'))
  const firstLink = lines.find((l) => l.startsWith('- ['))
  assert.equal(firstLink, '- [Platform guide](/llms-full.txt#platform-readme-md): The guide.')
  // A page outside the full set links to the repository.
  assert.ok(llms.includes('- [Deploy](https://github.com/landfalls-ai/landflow/blob/main/docs/deploy.md): Deploying.'))
  assert.ok(llms.endsWith('\n') && !llms.endsWith('\n\n'))
})

test('llms-full.txt: pages in order, anchors, links rewritten (FR-4, D8)', (t) => {
  const { full, problems } = render(tree(t))
  assert.deepEqual(problems, [])
  assert.ok(full.indexOf('<!-- page: platform/README.md -->') < full.indexOf('<!-- page: agents.md -->'))
  assert.ok(full.includes('# Platform guide {#platform-readme-md}'))
  assert.ok(full.includes('## Setup {#platform-readme-md--setup}'))
  // Published page in the full set: its heading's anchor. Outside the set: the repository. Unpublished: its text.
  assert.ok(full.includes('[agents](#agents-md--knowledge-bases)'))
  assert.ok(full.includes('[big page](https://github.com/landfalls-ai/landflow/blob/main/docs/deploy.md#x)'))
  assert.ok(full.includes('the limits.'))
  assert.ok(!full.includes('limitations.md'))
  assert.ok(full.includes('and code.'))
  // The same-page anchor gets the page prefix.
  assert.ok(full.includes('[setup](#platform-readme-md--setup)'))
  // The page's own H1 is emitted once.
  assert.equal(full.split('# Platform guide').length, 2)
})

test('a link whose text wraps onto the next line is rewritten, and a bad one is named by its line', (t) => {
  const wrapped = '# Agents\n\nSee [the\nlimits](limitations.md) and [the\nguide](platform/README.md#setup).\n'
  const { full, problems: found } = render(tree(t, { pages: { ...PAGES, 'agents.md': wrapped } }))
  assert.deepEqual(found, [])
  assert.ok(full.includes('See the\nlimits and [the\nguide](#platform-readme-md--setup).'))
  const bad = tree(t, { pages: { ...PAGES, 'agents.md': '# Agents\n\nOne\n\nSee [the\nspec](specs/a.md).\n' } })
  assert.ok(problems(bad).some((p) => p.includes('agents.md:5')))
})

test('a manifest entry under an internal path fails, naming it (AS-2, FR-2)', (t) => {
  for (const path of ['research/brain-ui-research.md', 'specs/a.md', 'history.md', 'constitution.md', 'notes/x.md']) {
    const root = tree(t, {
      pages: { ...PAGES, [path]: '# Title\n' },
      manifest: withManifest((m) => m.sections[0].pages.push({ path, title: 'Title', description: 'd', full: true })),
    })
    assert.ok(problems(root).some((p) => p.includes(path) && /internal/.test(p)), path)
  }
})

test('a link into an internal path fails with the page and the link (AS-3)', (t) => {
  const root = tree(t, { pages: { ...PAGES, 'agents.md': '# Agents\n\nSee [spec](specs/20-combined/README.md).\n' } })
  const found = problems(root)
  assert.ok(found.some((p) => p.includes('agents.md') && p.includes('specs/20-combined/README.md')), found.join('\n'))
})

test('a title that differs from the first heading fails; a missing file fails', (t) => {
  const root = tree(t, { pages: { ...PAGES, 'agents.md': '# Agents (Preview)\n' } })
  assert.ok(problems(root).some((p) => p.includes('agents.md') && p.includes('Agents (Preview)')))
  const gone = tree(t, { pages: { 'platform/README.md': PAGES['platform/README.md'], 'deploy.md': PAGES['deploy.md'] } })
  assert.ok(problems(gone).some((p) => p.includes('agents.md') && /missing/.test(p)))
})

test('duplicate manifest paths fail', (t) => {
  const root = tree(t, { manifest: withManifest((m) => m.sections[1].pages.push({ ...m.sections[0].pages[1] })) })
  assert.ok(problems(root).some((p) => /twice|duplicate/i.test(p)))
})

test('home-folder paths, foreign emails, session links and secrets fail (AS-5)', (t) => {
  const bad = {
    'path': 'Saved in /Users/somebody/work.',
    'email': 'Mail someone@company.io now.',
    'session': 'Claude-Session: https://claude.ai/code/session_FAKEFAKEFAKEFAKEFAKE',
    'key': 'Key AKIAABCDEFGHIJKLMNOP here.',
    'token': 'Use ghp_abcdefghijklmnopqrstuvwxyz0123456789 here.',
    'pem': '-----BEGIN PRIVATE KEY-----',
    'host': 'Call db1.mycompany.internal now.',
    'corp': 'Call vault.corp now.',
  }
  for (const [name, line] of Object.entries(bad)) {
    const root = tree(t, { pages: { ...PAGES, 'agents.md': `# Agents\n\nfirst\n${line}\n` } })
    const found = problems(root)
    assert.ok(found.some((p) => p.includes('agents.md:4')), `${name}: ${found.join(' | ')}`)
  }
  // It also covers a published page that is not in the full set, and the manifest's own text.
  const published = tree(t, { pages: { ...PAGES, 'deploy.md': '# Deploy\n\n/Users/x/y\n' } })
  assert.ok(problems(published).some((p) => p.includes('deploy.md:3')))
  const description = tree(t, { manifest: withManifest((m) => (m.sections[0].pages[0].description = 'ask a@b.io')) })
  assert.ok(problems(description).some((p) => p.includes('published.json')))
})

test('reserved example addresses and hosts pass', (t) => {
  const line = 'owner@landflow.test alice@example.com dev@mail.example.org http://localhost:3000 http://host.docker.internal:11434 api.landflow-dev.svc.cluster.local sk-landflow-dev-master-only pkg@1.2.3 @landflow/web'
  const root = tree(t, { pages: { ...PAGES, 'agents.md': `# Agents\n\n${line}\n` } })
  assert.deepEqual(problems(root), [])
})

test('code fences are neither rewritten nor given anchors, but are scanned', (t) => {
  const agents = '# Agents\n\n```md\n# not a heading\n[x](limitations.md)\n```\n'
  const { full, problems: found } = render(tree(t, { pages: { ...PAGES, 'agents.md': agents } }))
  assert.deepEqual(found, [])
  assert.ok(full.includes('# not a heading\n[x](limitations.md)\n'))
  assert.ok(!full.includes('# not a heading {#'))
})

test('size caps fail and list the three largest pages (AS-6, FR-7)', (t) => {
  const root = tree(t, { pages: { ...PAGES, 'agents.md': `# Agents\n\n${'x '.repeat(500)}\n` } })
  const found = problems(root, { limits: { llms: 20_000, full: 1000 } })
  const msg = found.find((p) => /llms-full\.txt/.test(p) && /1000|limit|over/i.test(p))
  assert.ok(msg, found.join('\n'))
  assert.ok(msg.indexOf('agents.md') >= 0 && msg.indexOf('agents.md') < msg.indexOf('platform/README.md'))
  assert.ok(problems(root, { limits: { llms: 50, full: 1_500_000 } }).some((p) => /llms\.txt/.test(p) && /50/.test(p)))
})

test('pages not in the manifest are listed once and do not fail (AS-8)', (t) => {
  const { notPublished, problems: found } = render(tree(t, { pages: { ...PAGES, 'extra.md': '# Extra\n', 'specs/s.md': '# S\n' } }))
  assert.deepEqual(found, [])
  assert.deepEqual(notPublished, ['extra.md', 'limitations.md'])
})

test('--check fails on a stale llms.txt and passes after --write (AS-4); two writes are identical (D9)', (t) => {
  const root = tree(t, { llms: 'stale\n' })
  const run = (mode) => spawnSync('node', [SCRIPT, mode, '--root', root], { encoding: 'utf8' })
  const stale = run('--check')
  assert.equal(stale.status, 1)
  assert.match(stale.stderr, /llms\.txt/)
  assert.equal(run('--write').status, 0)
  const first = [readFileSync(join(root, 'llms.txt')), readFileSync(join(root, 'llms-full.txt'))]
  assert.equal(run('--write').status, 0)
  assert.deepEqual([readFileSync(join(root, 'llms.txt')), readFileSync(join(root, 'llms-full.txt'))], first)
  const ok = run('--check')
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /not published: limitations\.md/)
  // The page changes after generation: the committed llms.txt only moves with the manifest, so a title edit is what fails.
  writeFileSync(join(root, 'agents.md'), '# Agents v2\n')
  assert.equal(run('--check').status, 1)
})

test('--write refuses to write while there are problems', (t) => {
  const root = tree(t, { pages: { ...PAGES, 'agents.md': '# Agents\n\n[s](specs/a.md)\n' } })
  const out = spawnSync('node', [SCRIPT, '--write', '--root', root], { encoding: 'utf8' })
  assert.equal(out.status, 1)
  assert.equal(existsSync(join(root, 'llms-full.txt')), false)
})

test('the real tree passes and runs in under two seconds', () => {
  const started = Date.now()
  const out = spawnSync('node', [SCRIPT, '--check'], { encoding: 'utf8' })
  assert.equal(out.status, 0, out.stderr)
  assert.ok(Date.now() - started < 2000)
})
