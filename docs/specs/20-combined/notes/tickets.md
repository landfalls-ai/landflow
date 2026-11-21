# Notes: C12 approval tickets (P12 `tickets`), parts a and b (P12a, P12b)

## docs/limitations.md

- A ServiceNow channel refuses plain alerts (a failed-run rule cannot use it; the "Notify on failure" picker leaves it out); it
  serves only rules with *Waits for your approval* (the rule's save refuses anything else).
- ServiceNow is tested against a local fake of its Table API only, not a real instance; field names beyond `short_description`,
  `description`, `correlation_id`, `work_notes` and `state` are not mapped (no custom fields).
- A webhook channel with Opens tickets still sends plain alerts like any webhook; only its Test and the approval tickets differ.

## docs/roadmap.md

- C12 built as tickets: ServiceNow and ticket-opening webhook channels, a ticket per approval request and ticket channel with retries,
  a closing note, and the link in Needs you, Home and the Run Trace card. The delegated decision (a ticket system deciding) was dropped by
  the person's decision of 2026-11-21.

## docs/README.md

No new page.

## For P12b

- `alerts/tickets.ts`: `openTicket(channel, request, test?)`, `closeTicket(channel, ref, { requestId, status, line })`,
  `testTicketChannel`; pass `alertStore.channelForSending(id)`. `TicketClose.requestId` is new against the plan (the webhook's
  settled event names the request). `opensTickets(channel)` in `lib/shared/alerts.ts` tells the ticket channels apart.
- Also touched outside the P12a table: `components/editor/notify-on-failure.tsx` (icon entry, ServiceNow filtered out).

## docs/limitations.md (part b)

- A lost answer during a leader hand-over can open a second ticket (the row stays `opening` and retries; the request id is the
  correlation id, so the ticket system can de-duplicate).
- A close that fails three times leaves the ticket open (audit `approval.ticket.failed`; nothing else shows it).
- A ticket opens within one ticker period (30 s) of the request, and closes likewise; a ServiceNow `state` is set only for the
  outcomes the channel maps.
- No ticket system decides; Jira and others are a webhook away; no custom field mapping. ServiceNow is tested against a fake only.
- `alerts-settings.tsx` is past 800 lines (P12a added one mount and an icon; splitting it is a follow-up).
