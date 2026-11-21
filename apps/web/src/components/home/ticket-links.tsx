/**
 * The tickets of an approval request, next to Approve and Deny (C12, docs/approval-inbox.md#tickets): "Ticket CHG0031" as a link
 * that opens in a new tab, "Ticket opening…" while the system has not been reached, "Ticket not opened" when it never was.
 * The ticket only notifies and links: deciding is still Approve and Deny here. Used by Home's rows and the Run Trace card.
 */
import { Ticket } from 'lucide-react';
import { ticketLabel, type InboxTicket } from '@/lib/shared/approval-inbox';

export function TicketLinks({ tickets, className }: { tickets?: InboxTicket[]; className?: string }) {
  if (!tickets?.length) return null;
  return (
    <p className={className ?? 'mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-t3'} data-testid="inbox-tickets">
      {tickets.map((ticket) => {
        const label = ticketLabel(ticket);
        const inner = (
          <>
            <Ticket className="size-3 shrink-0" aria-hidden /> {label}
          </>
        );
        return ticket.url && ticket.state !== 'opening' ? (
          <a key={ticket.channel} href={ticket.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ac underline-offset-2 hover:underline max-md:min-h-11" data-testid="inbox-ticket">
            {inner}
          </a>
        ) : (
          <span key={ticket.channel} className="inline-flex items-center gap-1" data-testid="inbox-ticket">
            {inner}
          </span>
        );
      })}
    </p>
  );
}
