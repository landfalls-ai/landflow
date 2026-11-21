# Notes: C12 approval tickets (P12 `tickets`), part a (P12a)

## docs/limitations.md

- A ServiceNow channel refuses plain alerts (a failed-run rule cannot use it; the "Notify on failure" picker leaves it out); it
  serves only rules with *Waits for your approval*, and that side lands with P12b.
- ServiceNow is tested against a local fake of its Table API only, not a real instance; field names beyond `short_description`,
  `description`, `correlation_id`, `work_notes` and `state` are not mapped (no custom fields).
- A webhook channel with Opens tickets still sends plain alerts like any webhook; only its Test and the approval tickets differ.

## docs/roadmap.md

- C12 part a built: ServiceNow and ticket-opening webhook channels (settings, open, close, Test). Part b (the inbox side) follows.

## docs/README.md

No new page.

## For P12b

- `alerts/tickets.ts`: `openTicket(channel, request, test?)`, `closeTicket(channel, ref, { requestId, status, line })`,
  `testTicketChannel`; pass `alertStore.channelForSending(id)`. `TicketClose.requestId` is new against the plan (the webhook's
  settled event names the request). `opensTickets(channel)` in `lib/shared/alerts.ts` tells the ticket channels apart.
- Also touched outside the P12a table: `components/editor/notify-on-failure.tsx` (icon entry, ServiceNow filtered out).
