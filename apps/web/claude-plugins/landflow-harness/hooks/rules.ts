/**
 * The guardrails and the redaction of landflow-harness, as plain functions (no engine calls), so Landflow's tests run
 * them too (apps/web/test/claude-harness-mod.test.ts). Each rule names what it stops and says why in words the model
 * reads back as the tool's error, so it can carry on another way.
 */

export interface Verdict {
  rule: string
  reason: string
}

/** Files that hold secrets: reading one puts the secret in the model's context. Examples and templates are fine. */
const SECRET_FILE = [
  /(^|\/)\.env(\.(?!example$|sample$|template$|dist$|defaults$)[\w.-]+)?$/,
  /(^|\/)\.(netrc|git-credentials|pgpass)$/,
  /(^|\/)\.ssh\/(?!known_hosts$|config$)[^/]+$/,
  /(^|\/)\.aws\/(credentials|config)$/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.kube\/config$/,
  /(^|\/)\.config\/gh\/hosts\.yml$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /(key|private)[^/]*\.pem$/i,
  /\.(key|p12|pfx|keystore|jks)$/,
  /(^|\/)(credentials|secrets?)\.(json|ya?ml|toml)$/,
  /^\/var\/run\/secrets\//,
  /^\/run\/secrets\//,
  /^\/proc\/[^/]+\/environ$/,
]

const FILE_TOOLS_READ = new Set(['Read', 'Grep', 'Glob', 'NotebookRead'])
const FILE_TOOLS_WRITE = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** `/a/b/../c` → `/a/c`; a relative path is taken from `cwd`. */
export function normalPath(path: string, cwd = '/'): string {
  const absolute = path.startsWith('/') ? path : `${cwd.replace(/\/+$/, '')}/${path}`
  const parts: string[] = []
  for (const part of absolute.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

export const isSecretFile = (path: string) => SECRET_FILE.some(re => re.test(path))

const within = (path: string, root: string) => path === root || path.startsWith(`${root.replace(/\/+$/, '')}/`)

/** A file tool's call: reading a secret file, or writing outside the places the agent works in (`roots`). */
export function guardFile(tool: string, input: Record<string, unknown>, roots: readonly string[], cwd = '/'): Verdict | undefined {
  const raw = [input.file_path, input.notebook_path, input.path].find(v => typeof v === 'string' && v.trim()) as string | undefined
  if (!raw) return undefined
  const path = normalPath(raw.trim(), cwd)
  if (FILE_TOOLS_READ.has(tool) && isSecretFile(path)) {
    return { rule: 'secret-file', reason: `${path} holds secrets, so it isn't read here. Use the example or template file, or ask for the value you need.` }
  }
  if (FILE_TOOLS_WRITE.has(tool) && roots.length && !roots.some(root => within(path, root))) {
    return { rule: 'write-outside-workspace', reason: `${path} is outside the places this agent works in (${roots.join(', ')}). Write inside them.` }
  }
  return undefined
}

/** A command line in its parts: `a && b; c | d` → ['a', 'b', 'c', 'd'] (quotes kept as written). */
export function segments(command: string): string[] {
  return command
    .split(/\n|&&|\|\||;|\|(?!\|)/)
    .map(s => s.trim())
    .filter(Boolean)
}

/** A segment's words, without leading `VAR=value` assignments, `sudo`, `command`, `exec`, `time`, `nohup` or `env X=y`. */
export function wordsOf(segment: string): string[] {
  const words = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  const unquoted = words.map(w => w.replace(/^["']|["']$/g, ''))
  let i = 0
  while (i < unquoted.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(unquoted[i]!) || ['sudo', 'command', 'exec', 'time', 'nohup', 'builtin'].includes(unquoted[i]!))) i++
  if (unquoted[i] === 'env' && unquoted.slice(i + 1).some(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && !w.startsWith('-'))) {
    i++
    while (i < unquoted.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(unquoted[i]!) || unquoted[i]!.startsWith('-'))) i++
  }
  return unquoted.slice(i)
}

const PROTECTED_BRANCH = /^(?:[^:]*:)?(?:refs\/heads\/)?(main|master)$/
const PUSH_FLAGS = new Set(['--force', '-f', '--force-with-lease', '--force-if-includes', '--delete', '-d', '--mirror', '--all', '--prune'])
const READERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'bat', 'base64', 'xxd', 'od', 'strings', 'nl', 'tac', 'hexdump', 'grep', 'rg', 'awk', 'sed', 'cut', 'sort', 'uniq', 'jq', 'yq', 'cp', 'scp', 'rsync', 'tar', 'zip'])
/** Copies read every argument but the last (the destination). */
const COPIERS = new Set(['cp', 'scp', 'rsync'])
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH)/i
const NETWORK_TOOLS = new Set(['nc', 'ncat', 'netcat', 'socat', 'telnet'])

/** git's subcommand and its arguments, past `-C dir`, `-c key=value` and other global flags. */
function gitArgs(words: string[]): { sub: string; args: string[]; config: string[] } | undefined {
  if (words[0] !== 'git') return undefined
  const config: string[] = []
  let i = 1
  while (i < words.length && words[i]!.startsWith('-')) {
    const flag = words[i]!
    if (flag === '-C' || flag === '-c' || flag === '--git-dir' || flag === '--work-tree') {
      if (flag === '-c' && words[i + 1]) config.push(words[i + 1]!)
      i += 2
    } else i++
  }
  return words[i] ? { sub: words[i]!, args: words.slice(i + 1), config } : undefined
}

const GIT_AUTH_KEY = /^(http\.|https\.|credential\.|url\.|core\.sshcommand|core\.askpass|include\.|includeif\.)/i

/** One segment of a Bash command: what it would do that the guardrails stop. */
function guardSegment(segment: string, cwd: string): Verdict | undefined {
  const words = wordsOf(segment)
  const head = words[0]?.replace(/^.*\//, '')
  if (!head) return undefined

  const git = gitArgs(words)
  if (git) {
    if (git.config.some(c => GIT_AUTH_KEY.test(c))) return { rule: 'git-auth-config', reason: "git's http, credential and URL settings are set for this sandbox: don't change them, not even with -c." }
    if (git.sub === 'config' && git.args.some(a => GIT_AUTH_KEY.test(a))) return { rule: 'git-auth-config', reason: "git's http, credential and URL settings are set for this sandbox: don't change them." }
    if (git.sub === 'push') {
      const flag = git.args.find(a => PUSH_FLAGS.has(a) || /^--(force|delete|mirror)/.test(a))
      if (flag) return { rule: 'git-push', reason: `\`git push ${flag}\` rewrites or deletes what others have. Push new commits to your own branch instead.` }
      const positional = git.args.filter(a => !a.startsWith('-'))
      const refspecs = positional.slice(1)
      if (refspecs.some(r => r.startsWith('+'))) return { rule: 'git-push', reason: 'A `+refspec` force-pushes. Push new commits to your own branch instead.' }
      if (refspecs.some(r => r.startsWith(':'))) return { rule: 'git-push', reason: 'A `:branch` refspec deletes the branch on the remote. Leave branches in place.' }
      const target = refspecs.find(r => PROTECTED_BRANCH.test(r))
      if (target) return { rule: 'git-push', reason: `Pushing to ${target.replace(/^.*:/, '')} isn't allowed: push to your own branch and open a pull request.` }
    }
    return undefined
  }

  if (head === 'gh') {
    if (words[1] === 'pr' && words[2] === 'merge') return { rule: 'merge', reason: "Merging pull requests is a person's call: say the pull request is ready instead." }
    if (words[1] === 'api' && words.some(w => /\/pulls\/\d+\/merge\b/.test(w))) return { rule: 'merge', reason: "Merging pull requests is a person's call: say the pull request is ready instead." }
    if (words[1] === 'auth' && ['token', 'status'].includes(words[2] ?? '') && words.includes('--show-token')) return { rule: 'env-dump', reason: "That prints GitHub's token. You don't need it: git and gh are already signed in." }
    if (words[1] === 'auth' && words[2] === 'token') return { rule: 'env-dump', reason: "That prints GitHub's token. You don't need it: git and gh are already signed in." }
    return undefined
  }

  // The environment holds the sandbox's keys: printing all of it, or one secret by name, shows them.
  if (head === 'printenv' && (words.length === 1 || words.slice(1).some(w => SECRET_NAME.test(w)))) return { rule: 'env-dump', reason: 'The environment holds keys and tokens: name the variable you need (one that is not a secret) instead.' }
  if (head === 'env' && words.length === 1) return { rule: 'env-dump', reason: 'The environment holds keys and tokens: name the variable you need (one that is not a secret) instead.' }
  if ((head === 'export' && words[1] === '-p') || (head === 'declare' && /^-[a-z]*[xp]/.test(words[1] ?? '')) || (head === 'set' && words.length === 1)) {
    return { rule: 'env-dump', reason: 'The environment holds keys and tokens: name the variable you need (one that is not a secret) instead.' }
  }
  if ((head === 'echo' || head === 'printf') && words.slice(1).some(w => /\$\{?[A-Za-z_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z_]*\}?/i.test(w))) {
    return { rule: 'env-dump', reason: 'That prints a secret from the environment. Use it where it is needed without printing it.' }
  }

  if (READERS.has(head)) {
    const positional = words.slice(1).filter(w => !w.startsWith('-'))
    const read = COPIERS.has(head) ? positional.slice(0, -1) : positional
    const secret = read.map(w => normalPath(w, cwd)).find(isSecretFile)
    if (secret) return { rule: 'secret-file', reason: `${secret} holds secrets, so it isn't read here. Use the example or template file, or ask for the value you need.` }
  }

  if (head === 'rm' && words.some(w => /^-[a-zA-Z]*[rR]/.test(w) || w === '--recursive')) {
    const target = words.slice(1).find(w => !w.startsWith('-') && /^(\/|\/\*|~|~\/|\$HOME|\$HOME\/|\$\{HOME\}|\.\.?\/?|\/(bin|boot|dev|etc|lib|proc|root|sbin|sys|usr|var|data)\/?)$/.test(w))
    if (target) return { rule: 'destructive', reason: `\`rm -r ${target}\` would delete far more than the work. Remove the files you made by name.` }
  }
  if (head?.startsWith('mkfs') || (head === 'dd' && words.some(w => /^of=\/dev\//.test(w))) || (head === 'chmod' && words.includes('-R') && words.some(w => /^(\/|~|\$HOME)$/.test(w)))) {
    return { rule: 'destructive', reason: 'That command changes the whole machine, not the work. It is not run here.' }
  }

  if (NETWORK_TOOLS.has(head)) return { rule: 'upload', reason: `${head} opens raw network connections. Use git, the package managers or curl for what you need to fetch.` }
  if (head === 'curl' || head === 'wget') {
    const upload = words.find(w => /^(-T|--upload-file|--post-file|--body-file)$/.test(w) || /^(-d|--data|--data-binary|--data-raw|--data-urlencode|--json|-F|--form)=?@/.test(w) || /^-[dF]@/.test(w))
    const next = words.findIndex(w => /^(-d|--data|--data-binary|--data-urlencode|--json|-F|--form)$/.test(w))
    if (upload || (next >= 0 && /(^|=)@/.test(words[next + 1] ?? ''))) return { rule: 'upload', reason: 'That sends a file over the network. Fetching is fine; uploading files is not done from here.' }
  }
  return undefined
}

/** What a Bash command would do that the guardrails stop, in its first part that does it. */
export function guardBash(command: string, cwd = '/'): Verdict | undefined {
  if (/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/.test(command)) return { rule: 'destructive', reason: 'That is a fork bomb.' }
  if (/>\s*\/dev\/(sd|nvme|vd|xvd)[a-z0-9]*/.test(command)) return { rule: 'destructive', reason: 'That writes over a disk.' }
  if (/\/proc\/[^/\s]+\/environ/.test(command)) return { rule: 'env-dump', reason: 'The environment holds keys and tokens: name the variable you need (one that is not a secret) instead.' }
  for (const segment of segments(command)) {
    const verdict = guardSegment(segment, cwd)
    if (verdict) return verdict
  }
  return undefined
}

/** Tokens and keys as their issuers write them, and what each is called when it is masked. */
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

/** The text with every secret it shows masked, and what kinds were masked. */
export function redact(text: string): { text: string; found: string[] } {
  const found: string[] = []
  let out = text
  for (const [pattern, name] of SECRETS) {
    out = out.replace(pattern, (match, ...groups) => {
      found.push(name)
      const keep = typeof groups[0] === 'string' && match.startsWith(groups[0]) ? groups[0] : ''
      const tail = name === 'password' && typeof groups[1] === 'string' ? groups[1] : ''
      return `${keep}[redacted ${name}]${tail}`
    })
  }
  return { text: out, found: [...new Set(found)] }
}
