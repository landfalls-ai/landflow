/**
 * Run profiles (docs/run-trace.md#profiles): the domain words, claims, role rules and deliveries the Run report's checks
 * use for one kind of flow. Optional and set per flow (WorkflowSettings.runProfile): a built-in id or a custom profile
 * as JSON. A flow without one gets the generic profile: the same screens and the checks that need no domain knowledge.
 * Patterns are regular expression sources, matched case-insensitively.
 */

/** An agent's own notes (Claude Code's `MEMORY.md`, its `memory/` and `.claude/` folders): never changes to the work. */
export const AGENT_NOTES = String.raw`(/(memory|\.claude)/|MEMORY\.md\b)`;
/**
 * Agent notes as a path in a repository: `MEMORY.md` at any depth and Claude Code's local `.claude/` state. Narrower than
 * AGENT_NOTES, because a project's own `memory/` folder is code (packages/transports/src/memory).
 */
export const AGENT_NOTES_PATH = String.raw`(^|/)MEMORY\.md$|(^|/)\.claude/(settings\.local\.json$|projects/|memory/)`;

/** A claim an agent may make ("typecheck passes") and the step that proves it (a tool call whose name or input matches). */
export interface ClaimRule {
  id: string;
  label: string;
  /** Matched against each claim (a structured reply's `claims`, else the sentences of the reply). */
  claim: string;
  /** Matched against a tool step's name and input: the latest matching step must have succeeded. */
  evidence: string;
}

/** Tools an actor's role excludes: a read-only reviewer editing files, a front desk issuing refunds. */
export interface RoleRule {
  label: string;
  /** Matched against the actor's name and id (`Reviewer remote:Reviewer`), not its description. */
  actor: string;
  /** Matched against the tool step's name and input. */
  deny: string;
}

/**
 * Work that has to be delivered: edits pushed, a draft sent. The last `work` step of an actor needs a later `delivery`.
 * Both are matched against a tool step as text: its name, what it worked on, then its input (`Write src/api.ts {…}`).
 */
export interface DeliveryRule {
  label: string;
  work: string;
  delivery: string;
}

/** What the gate does when a check fails: send the work back (the node's second output), ask a person, or only warn. */
export type RunGate = 'route' | 'ask' | 'warn';

export interface RunProfile {
  id: string;
  name: string;
  description?: string;
  /** The flow's own words for its outcome. */
  words?: { pass?: string; fail?: string };
  /** Artifact kinds that matter here, listed first in the report (`pull_request`, `ticket`, …). */
  artifacts?: string[];
  claims?: ClaimRule[];
  roles?: RoleRule[];
  deliveries?: DeliveryRule[];
  /** Words in a reply that sign the work off ("approved", "resolved"): a failed check followed by these is a problem not sent back. */
  approval?: string;
  gate?: RunGate;
  /** Built-in check ids this flow skips (BUILTIN_CHECKS). */
  mute?: string[];
}

/** The six built-in checks (lib/shared/run-report.ts). */
export const BUILTIN_CHECKS = [
  { id: 'claims', name: 'Claims against evidence', hint: 'An agent says something was done; the record shows whether the matching step last succeeded.' },
  { id: 'roles', name: 'Role rules', hint: 'An actor used a tool its role excludes.' },
  { id: 'unfinished', name: 'Unfinished work', hint: 'Something was started, asked for or promised but never delivered.' },
  { id: 'sent_back', name: 'Problems sent back', hint: 'A problem was found but never reached anyone who could fix it.' },
  { id: 'hidden', name: 'Hidden failures', hint: 'A step failed and the answer that followed does not mention it.' },
  { id: 'notes', name: 'Agent notes committed', hint: 'An agent’s own notes (MEMORY.md, its .claude/ state) reached the branch: they are not part of the work.' },
] as const;

export type BuiltinCheckId = (typeof BUILTIN_CHECKS)[number]['id'];

const GENERIC_APPROVAL = String.raw`\b(approved?|done|completed?|resolved|all set|looks good|lgtm|success(fully)?)\b`;

export const RUN_PROFILES: Record<'generic' | 'software' | 'support', RunProfile> = {
  generic: {
    id: 'generic',
    name: 'Generic',
    description: 'Any flow: the run’s status and the built-in checks that need no domain knowledge.',
    words: { pass: 'Done', fail: 'Needs attention' },
    approval: GENERIC_APPROVAL,
    gate: 'warn',
  },
  software: {
    id: 'software',
    name: 'Software delivery',
    description: 'Build teams: branches, commits and pull requests; tests and typecheck checked against what agents say.',
    words: { pass: 'Ready to merge', fail: 'Not ready to merge' },
    artifacts: ['pull_request', 'branch', 'commit', 'test_results'],
    claims: [
      { id: 'typecheck', label: 'Typecheck passes', claim: String.raw`type ?check|\btsc\b|types? (are|is) (fine|clean|ok)`, evidence: String.raw`\btsc\b|typecheck|type-check|mypy|pyright` },
      { id: 'tests', label: 'Tests pass', claim: String.raw`tests? (all )?(pass|are passing|passed|green)|all tests`, evidence: String.raw`vitest|jest|mocha|\b(pnpm|npm|yarn|bun)\b[^"|;&\n]*?\btest\b|go test|pytest|unittest|cargo test` },
      { id: 'lint', label: 'Lint is clean', claim: String.raw`lint(s|ing)? (is )?(clean|pass)`, evidence: String.raw`eslint|biome|ruff|golangci|lint` },
      { id: 'build', label: 'It builds', claim: String.raw`build(s)? (passes|succeeds|is green)|compiles`, evidence: String.raw`\b(pnpm|npm|yarn|bun)\b[^"|;&\n]*?\bbuild\b|go build|cargo build|tsc -b` },
      { id: 'pushed', label: 'Changes pushed', claim: String.raw`\bpushed\b|committed and pushed`, evidence: String.raw`git push` },
    ],
    // An agent's notes (Claude Code's `MEMORY.md`, its `memory/` and `.claude/` folders) are not changes to the code.
    roles: [{ label: 'Reviewers only read', actor: String.raw`review`, deny: String.raw`^(Edit|Write|MultiEdit|NotebookEdit) (?!\S*${AGENT_NOTES})|git (push|commit)` }],
    deliveries: [{ label: 'Every change pushed', work: String.raw`^(Edit|Write|MultiEdit) (?!\S*${AGENT_NOTES})`, delivery: String.raw`git push` }],
    approval: String.raw`\b(approve[ds]?|lgtm|looks good|ready to merge|ship it|no (blocking )?issues)\b`,
    gate: 'route',
  },
  support: {
    id: 'support',
    name: 'Customer support',
    description: 'Support desks: replies, refunds and ticket changes; promised actions checked against what was done.',
    words: { pass: 'Resolved', fail: 'Needs attention' },
    artifacts: ['reply', 'email', 'refund', 'ticket'],
    claims: [
      {
        id: 'email',
        label: 'Email sent',
        claim: String.raw`(i['’]?ve|i have|we['’]?ve|we have) (just )?(sent|emailed)|email (is|was|has been) sent|you(['’]ll| will) (receive|get) an? (email|confirmation)`,
        evidence: String.raw`e-?mail|gmail|smtp|send_?mail|sendgrid|mailgun|ses`,
      },
      { id: 'refund', label: 'Refund issued', claim: String.raw`refund(ed)? (has been|was|is) (issued|processed|done)|i['’]?ve refunded|refund is on its way`, evidence: String.raw`refund` },
      { id: 'ticket', label: 'Ticket updated', claim: String.raw`(updated|closed|escalated|reopened) (the|your) (ticket|case)`, evidence: String.raw`ticket|case|zendesk|jira|freshdesk|intercom|helpscout` },
    ],
    roles: [{ label: 'Front desk does not refund', actor: String.raw`front|triage|desk|greeter`, deny: String.raw`refund` }],
    approval: String.raw`\b(resolved|closed|all set|taken care of|done)\b`,
    gate: 'warn',
  },
};

/** The profile a flow uses: its setting (a built-in id or a custom profile), else the generic one. */
export function resolveRunProfile(setting: unknown): RunProfile {
  if (typeof setting === 'string' && setting in RUN_PROFILES) return RUN_PROFILES[setting as keyof typeof RUN_PROFILES];
  // A custom profile was validated when the workflow was saved (runProfileSchema in lib/server/schemas.ts).
  const custom = setting as Partial<RunProfile> | undefined;
  return custom && typeof custom === 'object' && typeof custom.id === 'string' && typeof custom.name === 'string' ? (custom as RunProfile) : RUN_PROFILES.generic;
}

/** A pattern of a profile as a case-insensitive RegExp; one that does not compile matches nothing. */
export function profilePattern(source: string | undefined): RegExp | undefined {
  if (!source) return undefined;
  try {
    return new RegExp(source, 'i');
  } catch {
    return undefined;
  }
}
