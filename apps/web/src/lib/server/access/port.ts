/**
 * The seam to a later access backend (Landbright, docs/access-requests.md#what-landbright-will-take-over). Routes, nodes and pages call
 * the port, never the built-in modules directly. The built-in backend (below) is registered when this module loads; Landbright will
 * register one that calls its machine API, and its sweeper replaces ours.
 */
import type { AccessEntryView, AccessGrantView, AccessRequestView, OutsideEntryView, OutsideGrantView, OutsideRequestView } from '../../shared/access';
import { singleton } from '../singleton';
import type { Actor } from '../projects/access';
import { getEntry, listEntries, listOpenToOutside } from './catalog';
import { applyDecision, giveBack, listGrants, listOwnGrants, revokeNow, type AppliedDecision, type ApplyOptions, type GrantScope } from './grants';
import type { Requester } from './principal';
import { cancelOwnRequest, createRequest, fileOutsideRequest, listOwnRequests, type RequestInput } from './requests';

export interface AccessBackend {
  catalog: { list(actor: Actor): AccessEntryView[]; get(actor: Actor, id: string): AccessEntryView | undefined; listOpenToOutside(): OutsideEntryView[] };
  ledger: {
    create(actor: Actor, input: RequestInput): Promise<AccessRequestView>;
    /** An outside requester's own side (C36): file, list, cancel and give back. `Requester` is Landbright's IdentityRef with `kind` widened. */
    outside: {
      create(requester: Requester, input: RequestInput): Promise<OutsideRequestView>;
      mine(requester: Requester): OutsideRequestView[];
      grants(requester: Requester): OutsideGrantView[];
      cancel(requester: Requester, id: string): Promise<OutsideRequestView>;
      giveBack(requester: Requester, grantId: string): Promise<OutsideGrantView>;
    };
    decide(requestId: string, executionId: string, outcome: 'approved' | 'rejected', options: ApplyOptions): Promise<AppliedDecision>;
    grants(actor: Actor, scope: GrantScope): AccessGrantView[];
    revoke(actor: Actor, grantId: string): Promise<AccessGrantView>;
  };
}

const builtin: AccessBackend = {
  catalog: {
    list: listEntries,
    get(actor, id) {
      try {
        return getEntry(actor, id);
      } catch {
        return undefined;
      }
    },
    listOpenToOutside,
  },
  ledger: {
    create: createRequest,
    outside: { create: fileOutsideRequest, mine: listOwnRequests, grants: listOwnGrants, cancel: cancelOwnRequest, giveBack },
    decide: applyDecision,
    grants: (actor, scope) => listGrants(actor, { scope }),
    revoke: revokeNow,
  },
};

const state = singleton('access-backend', () => ({ backend: builtin }));

export function registerAccessBackend(backend: AccessBackend): void {
  state.backend = backend;
}

export const accessBackend = (): AccessBackend => state.backend;
