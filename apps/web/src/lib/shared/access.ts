/**
 * Access requests (C35, docs/access-requests.md): the types the server and the Access page share. Browser-safe: no
 * server imports. The names follow Landbright's contract (`libs/contracts/src/access.ts`: target, step, vote, request and
 * grant status) so its catalog and grant ledger can take over behind `lib/server/access/port.ts`.
 */

export const ACCESS_SYSTEMS = ['github-team', 'github-org', 'github-repo', 'github-project', 'google-group', 'manual'] as const;
export type AccessSystem = (typeof ACCESS_SYSTEMS)[number];

export type RequestStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'failed';
export type GrantStatus = 'pending' | 'active' | 'removing' | 'expired' | 'revoked' | 'failed' | 'revoke_failed' | 'drift';

/** What a person sees for a request: the spec's words, one of them per request. */
export type AccessState = 'waiting' | 'approved' | 'granted' | 'denied' | 'expired' | 'failed' | 'cancelled' | 'removed';

/** One approval step. One step is built now; the data is an ordered list so more can follow (Landbright's policy.steps). */
export interface ApprovalStep {
  name: string;
  approvers: { userIds: string[] };
  approvalsRequired: 1;
}

/** What an entry grants: the system's own fields in `config` (see lib/server/access/systems.ts for each system's). */
export interface AccessTarget {
  key: string;
  type: AccessSystem;
  label: string;
  config: Record<string, string>;
}

export interface AccessEntryView {
  id: string;
  name: string;
  description?: string;
  system: AccessSystem;
  target: AccessTarget;
  /** Minutes the requester may pick, `null` for unlimited; at most 8. */
  durations: Array<number | null>;
  steps: ApprovalStep[];
  /** The people who approve (step 1), by name, for the form. */
  approverNames: string[];
  owners: string[];
  /** Empty: everyone signed in may ask. */
  eligibleUserIds: string[];
  enabled: boolean;
  /** Owners and admins only; never a value. */
  credentialId?: string;
  canEdit: boolean;
  version: number;
}

/** A person's answer on one step (Landbright's Vote). */
export interface AccessDecision {
  step: number;
  outcome: 'approve' | 'deny';
  by: string;
  byName?: string;
  comment?: string;
  channel: string;
  at: string;
  durationMinutes?: number | null;
}

export interface AccessRequestView {
  id: string;
  entryId: string;
  entryName: string;
  system: AccessSystem;
  requester: { id: string; name: string };
  account?: string;
  durationMinutes: number | null;
  reason: string;
  channel: 'form' | 'chat';
  status: RequestStatus;
  decisions: AccessDecision[];
  /** What the approver allowed (never more than asked). */
  approvedMinutes?: number | null;
  note?: string;
  grant?: AccessGrantView;
  /** Who may decide it: names, for the requester's "waiting for …". */
  approverNames: string[];
  /** The viewer is one of the approvers (and not the requester). */
  canDecide: boolean;
  canCancel: boolean;
  createdAt: string;
  executionId?: string;
}

export interface AccessGrantView {
  id: string;
  requestId?: string;
  entryId: string;
  entryName: string;
  holder: { id: string; name: string };
  account?: string;
  system: AccessSystem;
  targetLabel: string;
  status: GrantStatus;
  since?: string;
  until?: string | null;
  approvedBy?: string;
  endedAt?: string;
  endReason?: string;
  lastError?: string;
  /** The person had this access before Landflow granted it, so it is never taken back. */
  alreadyHad: boolean;
  canRevoke: boolean;
  canMarkDone: boolean;
  canRetry: boolean;
}

export interface AccessSetup {
  installed: boolean;
  /** The request flow is published and its trigger armed. */
  active: boolean;
  workflowId?: string;
  chatWorkflowId?: string;
  projectId?: string;
  /** The host can send email (the page is the only notice without it). */
  mail: boolean;
}

export const ACCESS_LIMITS = {
  durationsPerEntry: 8,
  maxMinutes: 129_600,
  reasonChars: [3, 500] as const,
  /** Ask a Person's timeout: a request nobody decides in 3 days expires. */
  decisionMinutes: 4_320,
  suggestedDurations: [15, 60, 240, 480, 1_440, 10_080, null] as Array<number | null>,
};

/** The state a person sees (spec item 3) from a request's status and its grant, if any. */
export function requestState(request: { status: RequestStatus; grant?: { status: GrantStatus } | null }): AccessState {
  switch (request.status) {
    case 'pending':
      return 'waiting';
    case 'denied':
      return 'denied';
    case 'expired':
      return 'expired';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
    case 'approved': {
      const grant = request.grant?.status;
      if (!grant || grant === 'pending') return 'approved';
      if (grant === 'failed') return 'failed';
      if (grant === 'expired' || grant === 'revoked' || grant === 'drift') return 'removed';
      return 'granted';
    }
  }
}

/** "15 min", "1 h", "1 h 30 min", "2 days", "unlimited". */
export function durationText(minutes: number | null): string {
  if (minutes === null) return 'unlimited';
  if (minutes < 60) return `${minutes} min`;
  if (minutes % 1_440 === 0) return minutes === 1_440 ? '1 day' : `${minutes / 1_440} days`;
  if (minutes < 1_440 || minutes % 60 === 0) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`.replace(/ 0 min$/, '');
}

const length = (minutes: number | null) => (minutes === null ? Infinity : minutes);

/** The durations an approver may allow for a request that asked for `asked`: the asked one first, then the shorter ones, longest first. */
export function shorterDurations(allowed: Array<number | null>, asked: number | null): Array<number | null> {
  return [...new Set(allowed)].filter((minutes) => length(minutes) <= length(asked)).sort((a, b) => length(b) - length(a));
}
