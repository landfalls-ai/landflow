'use client';
/**
 * The agent Spotlight designed, as a card to review (docs/assistant.md "Agents from Spotlight"): who it is, what it does,
 * the model, the tools (each with "asks first" when a person approves its calls), the knowledge, whether it follows the
 * approved practices, the guardrails in words and its test cases; then Create (on an empty canvas, with the flow that runs
 * it) or Dismiss. Created, it is a draft with a link to its page.
 */
import { useState } from 'react';
import { Check, ExternalLink, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { smokeLine, type AgentCard as AgentCardData } from '@/lib/shared/agent-card';
import type { AgentConfig } from '@/lib/shared/agents';
import { AgentAvatar } from '../../agents/avatar';
import { Button } from '../../ui/button';
import { createFromCard, dismissCard } from './agent-ask';

const CASES_SHOWN = 2;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-[12px] leading-snug">
      <span className="w-[68px] shrink-0 text-t3">{label}</span>
      <div className="min-w-0 flex-1 text-t1 [overflow-wrap:anywhere]">{children}</div>
    </div>
  );
}

export function AgentCardView({ itemId, card, busy = false }: { itemId: string; card: AgentCardData; busy?: boolean }) {
  const [allCases, setAllCases] = useState(false);
  const config = card.config as Partial<AgentConfig>;
  const created = card.state === 'created';
  const creating = card.state === 'creating';
  const cases = allCases ? card.cases : card.cases.slice(0, CASES_SHOWN);
  const left = [...card.needs, ...card.missing.map((m) => `Not available here: ${m}`)];
  return (
    <div data-testid="agent-card" className={cn('animate-fade-up rounded-xl border bg-sf p-2.5 transition-colors duration-200 motion-reduce:transition-none', created ? 'border-gnbd' : 'border-acbd')}>
      <div className="flex items-start gap-2">
        <AgentAvatar agent={{ color: config.color, avatar: config.avatar, icon: config.icon, name: card.name }} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[13px] font-semibold leading-snug text-t1 [overflow-wrap:anywhere]">
            {created && <Check className="size-3.5 shrink-0 animate-pop text-gn" />}
            {card.name}
          </div>
          <p className="mt-0.5 text-[12px] leading-snug text-t2 [overflow-wrap:anywhere]">{card.description}</p>
        </div>
      </div>
      <div className="mt-2 space-y-1.5">
        <Row label="Model">{card.model ?? <span className="text-t3">none yet: pick one on its page</span>}</Row>
        <Row label="Tools">
          {card.tools.length ? (
            <ul className="space-y-0.5">
              {card.tools.map((t, i) => (
                <li key={`${t.name}-${i}`}>
                  {t.name}
                  {t.requireApproval && <span className="ml-1 rounded-full border border-hair px-1.5 text-[10.5px] font-semibold text-t2">asks first</span>}
                  {t.writes && !t.requireApproval && <span className="ml-1 rounded-full border border-hair px-1.5 text-[10.5px] font-semibold text-t2">writes</span>}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-t3">none</span>
          )}
        </Row>
        {card.knowledge && <Row label="Knows">The “{card.knowledge}” knowledge base</Row>}
        {card.practices && <Row label="Practices">Follows your approved practices</Row>}
        {card.guardrails.length > 0 && (
          <Row label="Guardrails">
            <ul className="space-y-0.5">
              {card.guardrails.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          </Row>
        )}
        {card.cases.length > 0 && (
          <Row label="Tests">
            <ul className="space-y-0.5">
              {cases.map((c, i) => (
                <li key={`${i}-${c.input}`} className="line-clamp-2">
                  {c.input}
                </li>
              ))}
            </ul>
            {card.cases.length > CASES_SHOWN && (
              <button type="button" onClick={() => setAllCases((o) => !o)} aria-expanded={allCases} className="mt-0.5 min-h-5 text-[11.5px] font-semibold text-ac hover:underline max-md:min-h-9">
                {allCases ? 'Show fewer' : `Show all ${card.cases.length}`}
              </button>
            )}
          </Row>
        )}
        {left.length > 0 && <Row label="Left">{left.slice(0, 4).join('; ')}</Row>}
      </div>
      {card.state === 'failed' && card.error && (
        <p role="alert" className="mt-2 text-[12px] leading-snug text-rd [overflow-wrap:anywhere]">
          Couldn’t create it: {card.error}
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {created ? (
          <>
            <span className="text-[12px] font-semibold text-gn">Created as a draft</span>
            {card.agentId && (
              <a href={`/agents/${card.agentId}`} target="_blank" rel="noopener" className="flex min-h-7 items-center gap-0.5 text-[12px] font-semibold text-ac hover:underline max-md:min-h-11">
                Open <ExternalLink className="size-3" />
              </a>
            )}
            {card.smoke && <span className="basis-full text-[11.5px] text-t3">{smokeLine(card.smoke)}</span>}
          </>
        ) : (
          <>
            <Button size="sm" variant="primary" disabled={busy || creating} onClick={() => void createFromCard(itemId, card)} className="max-md:h-11 max-md:px-4">
              {creating && <Loader2 className="size-3.5 animate-spin" />}
              {creating ? 'Creating…' : card.state === 'failed' ? 'Try again' : card.starter ? 'Create agent and flow' : 'Create agent'}
            </Button>
            <Button size="sm" variant="ghost" disabled={creating} onClick={() => dismissCard(itemId)} className="max-md:h-11 max-md:px-4">
              Dismiss
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
