'use client';
/**
 * A review or comment a member left on GitHub through its MCP tools (lib/shared/review-comments.ts), in the member's
 * words: "Reviewer commented on src/nodes/get-alerts.ts line 42" with what they wrote quoted, or "Reviewer reviewed pull
 * request #5: approve". The Story tells it as a turn; the Artifacts tab lists it as a card that links to GitHub.
 */
import { ExternalLink, MessageSquareQuote } from 'lucide-react';
import { safeUrl } from '@/lib/shared/artifact-kinds';
import { reviewCommentCard } from '@/lib/shared/review-comments';
import type { RunArtifactItem } from '@/lib/shared/run-trace-model';
import { cut } from '@/lib/shared/run-trace-model';
import { Badge } from '../ui/badge';
import { Avatar, Card, Tap, clock, who } from './parts';
import type { Open } from './sheet';

const verdictTone = { APPROVE: 'success', REQUEST_CHANGES: 'danger', COMMENT: 'muted' } as const;

function Quote({ text, max }: { text: string; max: number }) {
  return <blockquote className="mt-1 whitespace-pre-wrap break-words rounded-2xl rounded-tl-md border border-hair bg-sf px-3 py-2 text-[13.5px] leading-snug text-t1">{cut(text, max)}</blockquote>;
}

/** The Story's turn: the member's avatar, what they did, and the words they wrote. */
export function ReviewCommentStory({ item, open }: { item: RunArtifactItem; open: (o: Open) => void }) {
  const card = reviewCommentCard(item.artifact);
  return (
    <Tap onClick={() => open({ kind: 'artifact', id: item.id })} label={`${item.actor?.name ?? 'A member'} ${card.verb}`} className="rounded-xl py-1.5 hover:bg-acdim/60">
      <div className="flex gap-2.5">
        <Avatar actor={item.actor} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[12px] text-t3">
            {who(item.actor)}
            <span className="break-all">{card.verb}</span>
            {card.verdict && <Badge tone={verdictTone[card.verdict]}>{card.verdict.toLowerCase().replace(/_/g, ' ')}</Badge>}
            <span className="ml-auto font-mono text-[11px] tabular-nums">{clock(item.at)}</span>
          </div>
          {card.quote && <Quote text={card.quote} max={600} />}
        </div>
      </div>
    </Tap>
  );
}

/** The Artifacts tab's card: the same sentence, the quote, and the link GitHub gave. */
export function ReviewCommentArtifact({ item, open }: { item: RunArtifactItem; open: (o: Open) => void }) {
  const card = reviewCommentCard(item.artifact);
  const url = safeUrl(card.url);
  return (
    <Card className="min-w-0 !p-0">
      <Tap onClick={() => open({ kind: 'artifact', id: item.id })} label={`${item.actor?.name ?? 'A member'} ${card.verb}`} className="rounded-2xl px-3.5 py-3 hover:bg-acdim/40">
        <span className="flex items-start gap-2">
          <MessageSquareQuote className="mt-[3px] size-3.5 shrink-0 text-t3" aria-hidden />
          <span className="min-w-0 flex-1">
            <b className="block break-words text-[13.5px] font-semibold text-t1">
              {item.actor?.name ?? 'A member'} {card.verb}
            </b>
            {card.quote && <span className="mt-1 block whitespace-pre-wrap break-words text-[13px] text-t2">{cut(card.quote, 400)}</span>}
            <span className="mt-0.5 block text-[12px] text-t3">
              {card.verdict ? `${card.verdict.toLowerCase().replace(/_/g, ' ')} · ` : ''}
              {clock(item.at)}
            </span>
          </span>
        </span>
      </Tap>
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer" className="flex min-h-9 items-center gap-1.5 border-t border-hair px-3.5 py-2 text-[12.5px] text-ac underline-offset-2 hover:underline">
          <ExternalLink className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-all">{url.replace(/^https?:\/\//, '')}</span>
        </a>
      )}
    </Card>
  );
}
