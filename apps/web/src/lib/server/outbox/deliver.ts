/**
 * One POST of an event to a subscription's URL (docs/features/event-subscriptions.md#what-is-sent): through safeFetch
 * (so the outbound policy applies at send time too, whatever the name resolves to now), 10 seconds, no redirects, the
 * body signed with the subscription's secret exactly as alert webhooks are (`x-landflow-signature` over
 * `<timestamp>.<body>`), and the event's stable id in `x-landflow-event-id` so the receiver can drop duplicates.
 */
import { refusal, request, signature } from '../alerts/http';
import type { SubscriptionDelivery } from '../../shared/event-subscriptions';

export interface DeliveryResult {
  ok: boolean;
  delivery: SubscriptionDelivery;
  /** A 410 Gone: the receiver asked not to be called again. */
  gone: boolean;
}

/** Send `body` (the event's JSON) to `url`. Never throws: the result says what happened. */
export async function deliverEvent(target: { url: string; secret: string }, event: { id: string; type: string }, body: string): Promise<DeliveryResult> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const started = Date.now();
  const headers = {
    'user-agent': 'Landflow-Events/1',
    'x-landflow-event': event.type,
    'x-landflow-event-id': event.id,
    'x-landflow-timestamp': timestamp,
    'x-landflow-signature': signature(target.secret, timestamp, body),
  };
  try {
    const response = await request('POST', target.url, body, headers, 'The receiver');
    const ms = Date.now() - started;
    if (response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return { ok: true, gone: false, delivery: { at: new Date().toISOString(), status: response.status, ms } };
    }
    const error = (await refusal(response, 'The receiver')).message;
    return { ok: false, gone: response.status === 410, delivery: { at: new Date().toISOString(), status: response.status, ms, error } };
  } catch (error) {
    return { ok: false, gone: false, delivery: { at: new Date().toISOString(), ms: Date.now() - started, error: (error as Error).message.slice(0, 300) } };
  }
}
