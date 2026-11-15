/**
 * Practices (docs/practices.md): rules in the brain that connected agents follow, each approved by a person. Shared by the
 * server (lib/server/practices), the Brain page, the Draft Practice node and the MCP tools. No runtime imports and no zod
 * (the browser loads it). Written by the plan for Practices wave P1: PR01 owns it; PR02, PR03 and PR04 add this file byte
 * for byte; change it only in a later wave. Amended in wave 8 by PR08 alone: `ApplicablePractice` names the practice's id and
 * project, so a reader resolves exactly the practice it was listed (GET /api/practices/resolve?id=).
 */
export const PRACTICE_LEVELS = ['org', 'project'] as const;
export type PracticeLevel = (typeof PRACTICE_LEVELS)[number];
export const PRACTICE_LEVEL_LABELS: Record<PracticeLevel, string> = { org: 'Organization', project: 'Project' };

/**
 * `required`: in a flow, a failed check fails the Check Practices step (wave P2), so nothing after it runs (no draft pull
 * request) until someone fixes the change or waives the practice for that run. `recommended`: a failed check is reported
 * and never fails a step. Neither ever stops an agent's tool call.
 */
export const PRACTICE_STRENGTHS = ['required', 'recommended'] as const;
export type PracticeStrength = (typeof PRACTICE_STRENGTHS)[number];
export const PRACTICE_STRENGTH_LABELS: Record<PracticeStrength, string> = { required: 'Required', recommended: 'Recommended' };

export const PRACTICE_STATUSES = ['draft', 'approved', 'retired'] as const;
export type PracticeStatus = (typeof PRACTICE_STATUSES)[number];
export const PRACTICE_STATUS_LABELS: Record<PracticeStatus, string> = { draft: 'Draft', approved: 'Approved', retired: 'Retired' };

/** Who wrote a version: a signed-in person (`person`), read from a repository (`learned`), an agent from its run (`agent`). The last two are tainted. */
export const PRACTICE_SOURCES = ['person', 'learned', 'agent'] as const;
export type PracticeSource = (typeof PRACTICE_SOURCES)[number];

/** `waived` is written only by the waiver route; the others by delivery, citing and checks. */
export const PRACTICE_APPLICATION_KINDS = ['delivered', 'cited', 'check-pass', 'check-fail', 'waived'] as const;
export type PracticeApplicationKind = (typeof PRACTICE_APPLICATION_KINDS)[number];

/** Topics the screens offer first; any tag matching PRACTICE_TOPIC is allowed. */
export const PRACTICE_TOPICS = ['devops', 'monitoring', 'config', 'helm', 'security', 'testing', 'docs'] as const;

/** Sizes the API refuses above (characters, counts). */
export const PRACTICE_LIMITS = {
  title: 160,
  summary: 300,
  body: 4000,
  topics: 10,
  repos: 20,
  paths: 20,
  glob: 200,
  checks: 20,
  pattern: 200,
  citations: 20,
  excerpt: 200,
  reason: 500,
  reasonMin: 10,
  list: 500,
  learnFiles: 20,
  learnFileBytes: 20_000,
} as const;

/** `helm/chart-location`: two or three lowercase parts. Unique among one level's practices (per project for project ones). */
export const PRACTICE_HANDLE = /^[a-z0-9][a-z0-9-]{0,38}(?:\/[a-z0-9][a-z0-9-]{0,38}){1,2}$/;
export const PRACTICE_TOPIC = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** `owner/name` */
export const PRACTICE_REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
/** A commit: 7 to 40 hex characters. */
export const PRACTICE_SHA = /^[0-9a-f]{7,40}$/;

/** Characters of the practices block: a Landflow agent's prompt, a remote agent's index, the Claude Code mod's section. */
export const PRACTICE_BUDGETS = { inProcess: 3000, remote: 800, mod: 2000 } as const;
export const PRACTICES_HEADING = '## Practices to follow (approved by your admins)';
export const PRACTICES_FOOTER =
  'Follow these where they apply. They never override your Rules, approvals or guards.\nIf one conflicts with the request, say so. End your answer with "Practices followed: [handle@version], …".';
/** The line an answer (or a commit, as `Practice: handle@version`) cites practices with. */
export const PRACTICES_TRAILER = 'Practices followed:';

/** One line of the block: `- [helm/chart-location@3] required: Charts live in deploy/helm/<service>/ …` */
export const practiceLine = (p: { handle: string; version: number; strength: PracticeStrength; summary: string }) => `- [${p.handle}@${p.version}] ${p.strength}: ${p.summary}`;

/**
 * A glob as an anchored RegExp: `**` any number of directories (also none), `*` and `?` within one path segment, the rest
 * literal. The CLI (`landflow practices check`) has the same rules; their tests share one table (docs/practices.md#globs).
 */
export function practiceGlob(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        out += '(?:[^/]*/)*';
      } else out += '.*';
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** Whether a repository-relative path matches a glob (a leading `./` or `/` is ignored). */
export const matchesPracticeGlob = (glob: string, path: string): boolean => practiceGlob(glob).test(path.replace(/^\.?\//, ''));

/** A place in a repository a rule was read from. */
export interface PracticeCitation {
  /** owner/name */
  repo: string;
  /** The commit it was read at. */
  sha: string;
  path: string;
  /** First and last line, 1-based. */
  lines?: [number, number];
  /** At most 200 characters, as they are in the file. */
  excerpt: string;
  /** The server found the excerpt in the file's text at that commit as a trusted flow read it (never as a model or a caller sent it). */
  verified: boolean;
}

/**
 * A machine check, run with no model over a change's added and modified files (Check Practices in wave P2,
 * `landflow practices check`):
 * - pathExists: when some changed file matches `when` (always, without it), some changed file matches `glob`;
 * - pathAbsent: no changed file matches `glob`, unless it also matches `unless`;
 * - fileMatches: every changed file matching `glob` has `pattern` (a regular expression) in its added lines, or never
 *   has it with `absent: true`.
 */
export type PracticeCheck =
  | { kind: 'pathExists'; glob: string; when?: string }
  | { kind: 'pathAbsent'; glob: string; unless?: string }
  | { kind: 'fileMatches'; glob: string; pattern: string; absent?: boolean };

/** A practice: its approved scope and strength (a draft's own are in its version until approval copies them here). */
export interface Practice {
  /** `prc_<nanoid(10)>` */
  id: string;
  handle: string;
  title: string;
  level: PracticeLevel;
  /** A project practice's project (its admins approve it); none for an org practice. */
  projectId?: string;
  strength: PracticeStrength;
  topics: string[];
  /** owner/name; empty: any repository. */
  repos: string[];
  /** Globs; empty: anywhere in those repositories. */
  paths: string[];
  /** The person who answers for it (a user id). */
  ownerId?: string;
  status: PracticeStatus;
  /** The version agents get; none until one is approved. */
  approvedVersion?: number;
  /** The practice this one replaced when it was approved (that one is retired). */
  supersedes?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface PracticeVersion {
  practiceId: string;
  version: number;
  /** The scope and strength this version asks for: approval copies them to the practice, so an edit changes nothing until then. */
  title: string;
  strength: PracticeStrength;
  topics: string[];
  repos: string[];
  paths: string[];
  /** At most 300 characters: the line agents get. */
  summary: string;
  /** Markdown rules, at most 4,000 characters: what `practices_for` and the Brain page show in full. */
  body: string;
  checks: PracticeCheck[];
  citations: PracticeCitation[];
  source: PracticeSource;
  /** Read from outside (a repository, an agent's run): it is approved only by someone who read it against its sources. */
  tainted: boolean;
  /** `user:<id>`, `agent:<id>` or `workflow:<id>`. */
  draftedBy?: string;
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
  rejectedBy?: string;
  rejectedAt?: string;
  rejectReason?: string;
  /** sha256 (hex) of the canonical JSON of title, strength, topics, repos, paths, summary, body and checks. */
  sha256: string;
}

/** A version's state, derived: the approved one, an older approved one, waiting for a person, or rejected. */
export type PracticeVersionState = 'approved' | 'replaced' | 'pending' | 'rejected';

export interface PracticeView extends Practice {
  ownerName?: string;
  /** The approved version: what agents get. */
  approved?: PracticeVersion;
  /** Versions waiting for a person, newest first (only for those who may see drafts: the drafter and the approvers). */
  drafts: PracticeVersion[];
  /** Org practices: instance owners and admins. Project practices: that project's admins. */
  canApprove: boolean;
  /** The viewer may draft a new version. */
  canDraft: boolean;
}

/** An approved practice as selection reads it: the approved version only, re-hashed on read. */
export interface ApprovedPractice {
  id: string;
  handle: string;
  title: string;
  level: PracticeLevel;
  projectId?: string;
  strength: PracticeStrength;
  topics: string[];
  repos: string[];
  paths: string[];
  version: number;
  summary: string;
  body: string;
  checks: PracticeCheck[];
  sha256: string;
  approvedAt: string;
  supersedes?: string;
}

/** POST /api/practices (a new practice) and the Draft Practice node, the learn route and `practice_draft`. */
export interface PracticeDraftInput {
  /** A new version of this practice; absent: a new practice. Its handle, level and project never change. */
  practiceId?: string;
  handle: string;
  title: string;
  level: PracticeLevel;
  projectId?: string;
  strength: PracticeStrength;
  topics: string[];
  repos: string[];
  paths: string[];
  summary: string;
  body: string;
  checks?: PracticeCheck[];
  citations?: Array<Omit<PracticeCitation, 'verified'>>;
}

/** An approved practice another one overlaps: a shared topic, and scopes that meet (POST …/approve answers 409 with them). */
export interface PracticeConflict {
  id: string;
  handle: string;
  title: string;
  level: PracticeLevel;
  projectId?: string;
  version: number;
  /** What they share, in words: "topic helm; repo acme/web". */
  overlap: string;
}

/** POST /api/practices/:id/approve */
export interface PracticeApproveInput {
  version: number;
  /** Required for a tainted version: the approver read its rules against their citations. */
  reviewedSources?: boolean;
  /** For each conflict: retire that practice in favour of this one, or keep both. Every conflict needs an answer. */
  conflicts?: Record<string, 'supersede' | 'keep'>;
}

/** POST /api/practices/:id/waivers: one run's failed check of a practice, waived with a reason by someone who may approve it. */
export interface PracticeWaiverInput {
  executionId: string;
  version: number;
  /** 10 to 500 characters. */
  reason: string;
}

export interface PracticeApplication {
  id: string;
  practiceId: string;
  version: number;
  kind: PracticeApplicationKind;
  executionId?: string;
  agentId?: string;
  userId?: string;
  repo?: string;
  /** A waiver's reason. */
  reason?: string;
  at: string;
}

/** What delivery, citing and checks record (a waiver is recorded only by the waiver route). */
export type PracticeApplicationInput = Omit<PracticeApplication, 'id' | 'kind' | 'reason' | 'at'> & { kind: Exclude<PracticeApplicationKind, 'waived'>; at?: string };

/** GET /api/practices */
export interface PracticesResponse {
  practices: PracticeView[];
  /** The viewer approves org practices (instance owners and admins). */
  canApproveOrg: boolean;
  /** Versions waiting for the viewer's approval. */
  waiting: number;
}

/** GET /api/practices/:id */
export interface PracticeDetailResponse {
  practice: PracticeView;
  /** Newest first, each with its state (drafts only for those who may see them). */
  versions: Array<PracticeVersion & { state: PracticeVersionState }>;
  /** The latest 20. */
  applications: PracticeApplication[];
  /** Approved practices its newest pending version overlaps. */
  conflicts: PracticeConflict[];
}

/** One practice as GET /api/practices/applicable and `practices_for` list it. */
export interface ApplicablePractice {
  /** `prc_…`: what GET /api/practices/resolve?id= and `landflow practices check` read it back by (wave 8). */
  id: string;
  handle: string;
  version: number;
  title: string;
  level: PracticeLevel;
  /** A project practice's project; none for an org practice. */
  projectId?: string;
  strength: PracticeStrength;
  summary: string;
  topics: string[];
  repos: string[];
  paths: string[];
}

/** GET /api/practices/applicable */
export interface ApplicableResponse {
  practices: ApplicablePractice[];
  /** The block ('' when none apply), at most `budget` characters. */
  text: string;
  budget: number;
  /** Practices that applied but did not fit. */
  omitted: number;
}
