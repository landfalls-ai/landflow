/**
 * Ledger events from sources that already announce themselves: agent runs (the bus's `agent` channel) and ratings
 * (chat-feedback's listeners). Every process listens to its own events; relayed ones (queue mode) are recorded where
 * they happened.
 */
import { bus, isRelayed } from '../bus';
import { onFeedback } from '../chat-feedback';
import { singleton } from '../singleton';
import { recordUsage } from './ledger';

export function startUsageListeners() {
  singleton('usage-source-listeners', () => {
    bus.subscribe((event) => {
      if (event.channel !== 'agent' || isRelayed(event) || event.event.type !== 'run.finished') return;
      const finished = event.event;
      recordUsage({
        kind: 'agent.session',
        agentId: event.agentId,
        tokens: (finished.usage?.inputTokens ?? 0) + (finished.usage?.outputTokens ?? 0),
        attrs: { session: finished.sessionId, status: finished.status, reason: finished.reason },
      });
    });
    onFeedback((feedback) => {
      recordUsage({
        kind: 'feedback',
        ...(feedback.workflowId && { workflowId: feedback.workflowId }),
        ...(feedback.agentId && { agentId: feedback.agentId }),
        ...(feedback.executionId && { executionId: feedback.executionId }),
        ...(feedback.comment && { message: feedback.comment }),
        attrs: { rating: feedback.rating, source: feedback.source, ...(feedback.sessionId && { session: feedback.sessionId }) },
      });
    });
    return true;
  });
}
