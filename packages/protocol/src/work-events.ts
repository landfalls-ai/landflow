/**
 * Work events (docs/work-and-briefings.md): the summary of a piece of someone's work that their local tools (the Claude
 * Code mod, `landflow work`, any harness over MCP) send to the second brain. Metadata only: a title, a short summary,
 * the repository and directory names, counts. Never code, file contents, file names or absolute paths.
 *
 * Shared by the host (POST /api/brain/work), the CLI and, by copy, the mod. Pure TypeScript with no dependencies.
 */

export const WORK_VISIBILITIES = ['private', 'team', 'org'] as const;
export type WorkVisibility = (typeof WORK_VISIBILITIES)[number];

export interface WorkEventPr {
  url: string;
  state: 'opened' | 'merged';
}

export interface WorkEventInput {
  /** `work.<name>`, such as `work.session`. */
  kind: string;
  /** The tool that sent it: `claude-code`, `landflow-cli`, `mcp`… (lowercase letters, digits and dashes). */
  source: string;
  /** Stable id of this item in its tool; sending it again updates the same event. */
  sourceId: string;
  /** ISO 8601. */
  occurredAt: string;
  endedAt?: string;
  title: string;
  summary?: string;
  /** `owner/name`. */
  repo?: string;
  branch?: string;
  /** Directory names only: never a file name or an absolute path. */
  areas?: string[];
  commits?: number;
  prs?: WorkEventPr[];
  turns?: number;
  initiative?: string;
  customer?: string;
  team?: string;
  url?: string;
  /** Private when left out. */
  visibility?: WorkVisibility;
}

export const WORK_LIMITS = {
  source: 40,
  sourceId: 200,
  title: 200,
  summary: 500,
  branch: 120,
  areas: 20,
  area: 80,
  prs: 10,
  hint: 120,
  url: 500,
  count: 1_000_000,
  /** A title longer than this that reads like code is refused. */
  codeTitle: 80,
} as const;

export type WorkEventResult = { ok: true; value: WorkEventInput } | { ok: false; errors: string[] };

const KIND = /^work\.[a-z0-9_]{1,56}$/;
const SOURCE = /^[a-z0-9-]+$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HTTP_URL = /^https?:\/\/\S+$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isoOk = (value: unknown): value is string => typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value));

/** An absolute path (POSIX, home-relative, UNC or a Windows drive). */
export const isAbsolutePath = (text: string): boolean => /^(\/|~|\\\\|[A-Za-z]:[\\/])/.test(text);

/** Whether the last segment of `text` looks like a file name with an extension (`app.ts`, `README.md`). */
export const hasFileExtension = (text: string): boolean => /[^./\\]\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(text.split(/[\\/]/).pop() ?? '');

/** Text that reads like source code rather than a sentence: braces and statements, an arrow, or several lines. */
export function looksLikeCode(text: string): boolean {
  if (/\r|\n/.test(text)) return true;
  const signs = [/[{}]/, /;\s*\S/, /=>/, /\(\s*\)/, /\b(?:function|const|let|var|import|return|class)\b\s*[\w({[]/].filter((pattern) => pattern.test(text)).length;
  return signs >= 2;
}

/** Check a work event as a client sends it. Unknown fields are dropped; every problem is listed. */
export function validateWorkEvent(input: unknown): WorkEventResult {
  const errors: string[] = [];
  if (!isObject(input)) return { ok: false, errors: ['A work event is an object'] };
  const text = (name: string, max: number, required = false): string | undefined => {
    const value = input[name];
    if (value === undefined || value === null) {
      if (required) errors.push(`${name} is required`);
      return undefined;
    }
    if (typeof value !== 'string') {
      errors.push(`${name} must be text`);
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      if (required) errors.push(`${name} is required`);
      return undefined;
    }
    if (trimmed.length > max) {
      errors.push(`${name} is at most ${max} characters`);
      return undefined;
    }
    return trimmed;
  };
  const count = (name: string): number | undefined => {
    const value = input[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > WORK_LIMITS.count) {
      errors.push(`${name} must be a whole number from 0 to ${WORK_LIMITS.count}`);
      return undefined;
    }
    return value;
  };

  const kind = text('kind', 64, true);
  if (kind && !KIND.test(kind)) errors.push('kind is work.<name>: lowercase letters, digits and underscores');
  const source = text('source', WORK_LIMITS.source, true);
  if (source && !SOURCE.test(source)) errors.push('source is lowercase letters, digits and dashes');
  const sourceId = text('sourceId', WORK_LIMITS.sourceId, true);
  const title = text('title', WORK_LIMITS.title, true);
  if (title && title.length > WORK_LIMITS.codeTitle && looksLikeCode(title)) errors.push('title reads like code; send a one-line description of the work');
  else if (title && /\r|\n/.test(title)) errors.push('title is one line');
  const summary = text('summary', WORK_LIMITS.summary);
  const branch = text('branch', WORK_LIMITS.branch);
  const url = text('url', WORK_LIMITS.url);
  if (url && !HTTP_URL.test(url)) errors.push('url must start with http:// or https://');
  const repo = text('repo', 140);
  if (repo && !REPO.test(repo)) errors.push('repo is owner/name');
  const initiative = text('initiative', WORK_LIMITS.hint);
  const customer = text('customer', WORK_LIMITS.hint);
  const team = text('team', WORK_LIMITS.hint);

  if (!isoOk(input.occurredAt)) errors.push('occurredAt must be an ISO 8601 time');
  if (input.endedAt !== undefined && input.endedAt !== null && !isoOk(input.endedAt)) errors.push('endedAt must be an ISO 8601 time');

  let areas: string[] | undefined;
  if (input.areas !== undefined && input.areas !== null) {
    if (!Array.isArray(input.areas)) errors.push('areas must be a list');
    else if (input.areas.length > WORK_LIMITS.areas) errors.push(`areas holds at most ${WORK_LIMITS.areas} names`);
    else {
      areas = [];
      for (const area of input.areas) {
        if (typeof area !== 'string' || !area.trim()) errors.push('each area is a directory name');
        else if (area.length > WORK_LIMITS.area) errors.push(`each area is at most ${WORK_LIMITS.area} characters`);
        else if (isAbsolutePath(area.trim())) errors.push(`area “${area.slice(0, 40)}” is an absolute path; send directory names only`);
        else if (area.includes('..')) errors.push(`area “${area.slice(0, 40)}” climbs out of the repository`);
        else if (hasFileExtension(area.trim())) errors.push(`area “${area.slice(0, 40)}” is a file name; send directory names only`);
        else areas.push(area.trim());
      }
    }
  }

  let prs: WorkEventPr[] | undefined;
  if (input.prs !== undefined && input.prs !== null) {
    if (!Array.isArray(input.prs)) errors.push('prs must be a list');
    else if (input.prs.length > WORK_LIMITS.prs) errors.push(`prs holds at most ${WORK_LIMITS.prs} pull requests`);
    else {
      prs = [];
      for (const pr of input.prs) {
        const ok = isObject(pr) && typeof pr.url === 'string' && HTTP_URL.test(pr.url) && pr.url.length <= WORK_LIMITS.url && (pr.state === 'opened' || pr.state === 'merged');
        if (ok) prs.push({ url: (pr as { url: string }).url, state: (pr as { state: 'opened' | 'merged' }).state });
        else errors.push('each pull request is { url, state: opened | merged }');
      }
    }
  }

  const commits = count('commits');
  const turns = count('turns');
  let visibility: WorkVisibility | undefined;
  if (input.visibility !== undefined && input.visibility !== null) {
    if ((WORK_VISIBILITIES as readonly unknown[]).includes(input.visibility)) visibility = input.visibility as WorkVisibility;
    else errors.push('visibility is private, team or org');
  }

  if (errors.length || !kind || !source || !sourceId || !title) return { ok: false, errors: errors.length ? errors : ['A work event needs kind, source, sourceId, occurredAt and title'] };
  return {
    ok: true,
    value: {
      kind,
      source,
      sourceId,
      occurredAt: input.occurredAt as string,
      ...(typeof input.endedAt === 'string' && { endedAt: input.endedAt }),
      title,
      ...(summary && { summary }),
      ...(repo && { repo }),
      ...(branch && { branch }),
      ...(areas?.length && { areas }),
      ...(commits !== undefined && { commits }),
      ...(prs?.length && { prs }),
      ...(turns !== undefined && { turns }),
      ...(initiative && { initiative }),
      ...(customer && { customer }),
      ...(team && { team }),
      ...(url && { url }),
      ...(visibility && { visibility }),
    },
  };
}
