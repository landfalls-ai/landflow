/**
 * The approval inbox's port (docs/approval-inbox.md): implements `InboxPort` (port.ts, an ap1 contract) on the store and the
 * nudges, registers it (lib/server/runtime.ts imports this file), and settles a cancelled run's waiting requests from the bus.
 * Plain server module (no Next.js import): workers load it.
 */
import { getUser } from '../auth/users';
import { bus, isRelayed } from '../bus';
import { singleton } from '../singleton';
import { logger } from '../telemetry';
import { registerAlertCheck } from '../alerts/extra-checks';
import { checkApprovalAlerts, nudgeNew } from './nudge';
import { registerInboxPort, type InboxPort } from './port';
import { view } from './access';
import * as inbox from './store';

export const approvalInbox: InboxPort = {
  async open(calls) {
    const { ids, expiresAt, minutes, created } = inbox.openRequests(calls);
    // Once per new request: a re-open (a node that ran again after a resume or a crash) nudges nobody.
    if (created.length) nudgeNew(created);
    return { ids, expiresAt, minutes };
  },
  outcome: inbox.outcome,
  async settle(executionId, callId, to) {
    const row = inbox.rowFor(executionId, callId);
    if (!row) return { won: false, outcome: { status: 'cancelled' } };
    const result = await inbox.claim(row.id, to, { via: to === 'expired' ? 'expiry' : 'cancel' });
    return { won: result.won, outcome: result.row ? inbox.outcomeOf(result.row) : { status: to } };
  },
  view: (id, viewerId) => view(id, viewerId ? getUser(viewerId) : undefined),
};

registerInboxPort(approvalInbox);
// The `approval` alert event is delivered by the alert service's ticker.
registerAlertCheck('approval requests', checkApprovalAlerts);

// A run cancelled while it waited settles its requests `cancelled` (an approval after that answers 409).
const subscription = singleton('approval-inbox-bus', () => ({ off: undefined as (() => void) | undefined }));
subscription.off?.();
subscription.off = bus.subscribe((event) => {
  if (event.channel !== 'execution' || event.event.type !== 'execution.finished' || isRelayed(event)) return;
  const status = (event.event as { status?: string }).status;
  if (status !== 'canceled') return;
  const executionId = (event.event as { executionId: string }).executionId;
  void inbox.cancelExecution(executionId).catch((error: Error) => logger.warn('approval requests of a cancelled run not settled', { 'landflow.execution.id': executionId, error: error.message }));
});
