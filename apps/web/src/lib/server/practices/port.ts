/**
 * The practices store's port (docs/practices.md#how-it-is-built): the store sets it (lib/server/practices/register.ts, a
 * side-effect import at the top of lib/server/runtime.ts, both roles), and the Draft Practice node and the learn route
 * (PR03), the applicable and cite routes and the MCP tools (PR04) read it, so in wave P1 none of them imports the store.
 * Unset (a test, a script that never boots runtime.ts): nothing is drafted or delivered, and callers say so. Tests set
 * fakes. Written by the plan for Practices wave P1: PR01 owns it; PR03 and PR04 add this file byte for byte; change it only
 * in a later wave.
 */
import type { ApprovedPractice, PracticeApplicationInput, PracticeDraftInput, PracticeSource, PracticeVersion, PracticeView } from '../../shared/practices';
import type { Actor } from '../projects/access';
import { singleton } from '../singleton';

/** Who a draft comes from. The caller decides `source`; the store decides who may draft at that level and project. */
export interface PracticeDraftOrigin {
  /** `person` only for a signed-in session's own typing; an API key, a flow, the mod or an MCP client is `learned` or `agent` (tainted). */
  source: PracticeSource;
  /** The signed-in person or the API key's user; undefined for a flow run no person started and for the instance token. */
  actor?: Actor;
  agentId?: string;
  workflowId?: string;
  executionId?: string;
  /**
   * File text a trusted flow read at the cited commit (Draft Practice in a flow an owner or admin saved, never a model's or
   * a caller's text): a citation whose excerpt is in its file's text here is marked verified. Without it none is.
   */
  files?: ReadonlyArray<{ repo: string; sha: string; path: string; content: string }>;
}

export interface PracticesPort {
  /** LANDFLOW_PRACTICES is not `off`. Drafting and approving work either way; `approved()` is [] when off. */
  enabled(): boolean;
  /**
   * Save a draft version: a new practice, or the next version of `input.practiceId`. Throws an HttpError (400 invalid,
   * 403 may not draft there, 404 unknown practice or project, 409 handle taken) for the caller to pass on.
   */
  draft(input: PracticeDraftInput, origin: PracticeDraftOrigin): { practice: PracticeView; version: PracticeVersion };
  /**
   * Approved practices only: every org practice plus the project practices of `projectIds` ('all': every project). Each
   * version is re-hashed on read and left out (and logged) when its sha256 differs. [] when not enabled.
   */
  approved(scope: { projectIds: readonly string[] | 'all' }): ApprovedPractice[];
  /** Write one practice_applications row (delivered, cited, check-pass, check-fail). Never throws. */
  record(row: PracticeApplicationInput): void;
}

const slot = () => singleton('practices-port', () => ({ port: undefined as PracticesPort | undefined }));

export function setPracticesPort(port: PracticesPort | undefined): void {
  slot().port = port;
}
export const practicesPort = (): PracticesPort | undefined => slot().port;
