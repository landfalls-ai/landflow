/**
 * The seam between a run that pauses (AP02: the Run an Agent node) and the approval inbox (AP01: the record, the claim, the
 * nudges). Wave ap1; docs/approval-inbox.md.
 *
 * This file is the one copy of the contract (the old `backbone/contracts/ap1` folder is gone): edit it here.
 *
 * AP01 registers its implementation once, from the host's side-effect registrations (lib/server/runtime.ts, lesson 10: a later
 * registration replaces an earlier one, so a test that wants a fake imports the real module first, then registers the fake).
 * Without a registered port the node refuses as before (`REFUSE_WHY.noInbox`): a host never pauses a run nobody can answer.
 *
 * Plain server module: no Next.js import, no zod; workers load it.
 */
import type { InboxOpen, InboxRequestView, InboxStatus, InboxVia } from '../../shared/approval-inbox';
import { singleton } from '../singleton';

export interface InboxOutcome {
  status: InboxStatus;
  by?: string;
  byName?: string;
  via?: InboxVia;
  at?: string;
}

export interface InboxPort {
  /**
   * Open one request per call, idempotent on (executionId, callId): a node that runs again after a crash or a resume gets the
   * same ids and nudges nobody twice. Nudges go out once per request, in the background, never failing the run.
   * Returns callId → request id, and the expiry every request of this wait shares (now + the expiry variable, read now).
   */
  open(calls: InboxOpen[]): Promise<{ ids: Record<string, string>; expiresAt: string; minutes: number }>;
  /** The record's state for one call of an execution (the run reads it on every resume: it is the truth). */
  outcome(executionId: string, callId: string): InboxOutcome | undefined;
  /**
   * Move a waiting request to `expired` or `cancelled` (the node on a timeout resume; the bus on a cancelled run). Conditional:
   * `won` is false when another door settled it first, and `outcome` is then the winner's. Approve and deny never come here:
   * they go through decideApproval (lib/server/approvals.ts), which claims with the same conditional update.
   */
  settle(executionId: string, callId: string, to: 'expired' | 'cancelled'): Promise<{ won: boolean; outcome: InboxOutcome }>;
  /** One request as the routes show it, for `viewerId` (canDecide); undefined when it does not exist. */
  view(id: string, viewerId?: string): InboxRequestView | undefined;
}

const holder = singleton('approval-inbox-port', () => ({ port: undefined as InboxPort | undefined }));

/** AP01's registration (runtime.ts). Replaces whatever was registered before. */
export function registerInboxPort(port: InboxPort): void {
  holder.port = port;
}

/** The registered inbox, or undefined (then a run nobody watches refuses as before). */
export function inboxPort(): InboxPort | undefined {
  return holder.port;
}
