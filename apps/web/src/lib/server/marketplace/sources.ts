/**
 * Marketplace and plugin sources (Claude Code marketplace reference): what a user can add as a
 * marketplace, and where each plugin entry's `source` points. Only GitHub is fetched remotely;
 * other hosts and source types (npm, archive, command…) show up as unsupported in the catalog.
 */
import { isAbsolute, resolve } from 'node:path';
import type { MarketplaceLocation, ResolvedSource } from '../../shared/marketplace';

const OWNER_REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

export const localAllowed = () => process.env.LANDFLOW_MARKETPLACE_ALLOW_LOCAL === '1';

/** `owner/repo` from a GitHub shorthand or a github.com URL (`.git` and trailing paths allowed). */
export function githubRepo(value: string): { owner: string; repo: string; ref?: string; path?: string } | undefined {
  const text = value.trim();
  const short = OWNER_REPO.exec(text.replace(/\.git$/, ''));
  if (short) return { owner: short[1], repo: short[2] };
  let url: URL;
  try {
    url = new URL(text.replace(/^git\+/, ''));
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return undefined;
  const [owner, rawRepo, kind, ref, ...rest] = url.pathname.split('/').filter(Boolean);
  const repo = rawRepo?.replace(/\.git$/, '');
  if (!owner || !repo || !OWNER_REPO.test(`${owner}/${repo}`)) return undefined;
  // https://github.com/o/r/tree/<ref>/<path>
  if ((kind === 'tree' || kind === 'blob') && ref) return { owner, repo, ref, ...(rest.length && { path: rest.join('/') }) };
  return { owner, repo };
}

/** What the user typed in "Add marketplace". */
export function parseMarketplaceInput(input: string): MarketplaceLocation {
  const text = input.trim();
  if (!text) throw new Error('Enter a GitHub repository (owner/repo) or a marketplace.json URL');
  // owner/repo@ref or owner/repo#ref
  const pinned = /^([^@#\s]+)[@#]([\w./-]+)$/.exec(text);
  if (pinned && OWNER_REPO.test(pinned[1])) {
    const [owner, repo] = pinned[1].split('/');
    return { kind: 'github', owner, repo, ref: pinned[2] };
  }
  const gh = githubRepo(text);
  if (gh) return { kind: 'github', owner: gh.owner, repo: gh.repo, ...(gh.ref && { ref: gh.ref }) };
  if (/^https?:\/\//i.test(text)) {
    const url = new URL(text);
    // A raw marketplace.json on GitHub: keep the repo so relative sources resolve.
    if (url.hostname === 'raw.githubusercontent.com') {
      const [owner, repo, ref] = url.pathname.split('/').filter(Boolean);
      if (owner && repo && ref && url.pathname.endsWith('/.claude-plugin/marketplace.json')) return { kind: 'github', owner, repo, ref };
    }
    return { kind: 'url', url: url.toString() };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !text.startsWith('file:')) throw new Error('Only http(s) URLs and GitHub repositories are supported');
  if (localAllowed()) {
    const path = text.startsWith('file:') ? new URL(text).pathname : text;
    if (!isAbsolute(path)) throw new Error('A local marketplace needs an absolute path');
    return { kind: 'local', path: resolve(path) };
  }
  throw new Error('Enter a GitHub repository like anthropics/claude-plugins-official, a github.com URL or a marketplace.json URL');
}

export function locationLabel(location: MarketplaceLocation): string {
  if (location.kind === 'github') return `github.com/${location.owner}/${location.repo}${location.ref ? ` @ ${location.ref}` : ''}`;
  return location.kind === 'url' ? location.url : location.path;
}

/** Join a relative plugin path onto a base directory; refuses `..` and absolute paths. */
export function joinRelative(base: string, relative: string): string {
  const parts = relative.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) throw new Error(`Path contains "..": ${relative}`);
  return [...base.split('/').filter(Boolean), ...parts].join('/');
}

const SHA = /^[0-9a-f]{40}$/;

/** Resolve one plugin entry's `source` against the marketplace it is listed in. */
export function resolveSource(source: unknown, marketplace: MarketplaceLocation, pluginRoot?: string): ResolvedSource {
  try {
    if (typeof source === 'string') {
      let relative = source.trim();
      if (pluginRoot && !relative.startsWith('.') && !relative.includes('/')) relative = joinRelative(pluginRoot, relative);
      else if (relative !== '.' && !relative.startsWith('./')) return { kind: 'unsupported', reason: `Relative sources start with "./" (got "${source}")` };
      if (marketplace.kind === 'github') {
        return { kind: 'github', owner: marketplace.owner, repo: marketplace.repo, ref: marketplace.ref ?? 'HEAD', path: joinRelative('', relative) };
      }
      if (marketplace.kind === 'local') return { kind: 'local', root: marketplace.path, path: joinRelative('', relative) };
      return { kind: 'unsupported', reason: 'A marketplace added from a URL has no files, so relative sources can’t resolve' };
    }
    if (!source || typeof source !== 'object') return { kind: 'unsupported', reason: 'Missing source' };
    const s = source as Record<string, unknown>;
    const ref = typeof s.ref === 'string' && s.ref.trim() ? s.ref.trim() : undefined;
    const sha = typeof s.sha === 'string' && SHA.test(s.sha) ? s.sha : undefined;
    const pinned = (owner: string, repo: string, path: string): ResolvedSource => ({ kind: 'github', owner, repo, ref: sha ?? ref ?? 'HEAD', path, ...(sha && { sha }) });
    switch (s.source) {
      case 'github': {
        const gh = typeof s.repo === 'string' ? githubRepo(s.repo) : undefined;
        return gh ? pinned(gh.owner, gh.repo, '') : { kind: 'unsupported', reason: 'github source needs repo: "owner/repo"' };
      }
      case 'url':
      case 'git': {
        const gh = typeof s.url === 'string' ? githubRepo(s.url) : undefined;
        return gh ? pinned(gh.owner, gh.repo, '') : { kind: 'unsupported', reason: `Only GitHub-hosted git sources are supported (${String(s.url ?? '?')})` };
      }
      case 'git-subdir': {
        const gh = typeof s.url === 'string' ? githubRepo(s.url) : undefined;
        if (!gh) return { kind: 'unsupported', reason: `Only GitHub-hosted git sources are supported (${String(s.url ?? '?')})` };
        return pinned(gh.owner, gh.repo, joinRelative('', typeof s.path === 'string' ? s.path : ''));
      }
      case 'local':
        // Tests and LANDFLOW_MARKETPLACE_ALLOW_LOCAL=1 only.
        if (localAllowed() && typeof s.path === 'string' && isAbsolute(s.path)) return { kind: 'local', root: resolve(s.path), path: '' };
        return { kind: 'unsupported', reason: 'Local sources are disabled' };
      default:
        return { kind: 'unsupported', reason: `"${String(s.source)}" sources aren’t supported yet` };
    }
  } catch (error) {
    return { kind: 'unsupported', reason: (error as Error).message };
  }
}

export function sourceLabel(source: ResolvedSource, raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (source.kind === 'github') return `github.com/${source.owner}/${source.repo}${source.path ? `/${source.path}` : ''}${source.sha ? ` @ ${source.sha.slice(0, 7)}` : source.ref !== 'HEAD' ? ` @ ${source.ref}` : ''}`;
  if (source.kind === 'local') return `${source.root}${source.path ? `/${source.path}` : ''}`;
  const s = raw as Record<string, unknown> | undefined;
  return String(s?.source ?? 'unknown');
}
