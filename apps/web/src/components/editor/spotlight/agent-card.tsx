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
import { publishLine, smokeLine, type AgentCard as AgentCardData } from '@/lib/shared/agent-card'; // AG04: publishLine
import type { AgentConfig } from '@/lib/shared/agents';
import { AgentAvatar } from '../../agents/avatar';
import { Button } from '../../ui/button';
import { applyAgentChange, createFromCard, dismissCard, publishAgentChange, setCardModel, testAgentChange } from './agent-ask'; // AG02: setCardModel; AG04: applyAgentChange, publishAgentChange; AG09: testAgentChange
import { stillLeft, useAgentDraft } from '@/lib/client/agent-change'; // AG09:
import { useAssistant } from '../assistant';

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
  const draft = useAgentDraft(card.base?.agentId); // AG09: a change card's Left row is what the agent's draft still lacks
  const left = [...(card.base ? stillLeft(card.needs, draft) : card.needs) /* AG09: */, ...card.missing.map((m) => `Not available here: ${m}`)];
  // Integration (sb3): after Create the line is SB18's smoke line, live from the agent's row ("tested, 1 of 1 passed · published").
  const row = useAssistant((s) => (card.agentId ? s.agents.find((a) => a.agentId === card.agentId) : undefined));
  const smoke = row?.smoke ?? card.smoke;
  // AG05: what the row says while the eval gate runs and after (held stays); the same words, from `publishLine`.
  const publish = row ? row.publish : card.publish;
  const tested = smoke ? `${smokeLine(smoke)}${smoke.state === 'passed' && smoke.reason ? ` · ${smoke.reason}` : ''}` : 'Created as a draft';
  const createdLine = publish?.state === 'publishing' ? publishLine(publish) : `${tested}${publish && publish.state !== 'published' ? ` · ${publishLine(publish)}` : row?.state === 'published' ? ' · published' : ''}`;
  const needsCredential = smoke?.state === 'untested' && Boolean(smoke.reason?.startsWith('needs a credential'));
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
        {/* AG02: a designed card's Model is a select of the models this host offers (the host's builder model first); after Create it is text. */}
        <Row label="Model">
          {card.state === 'designed' && card.models && card.models.length > 1 ? (
            <select
              aria-label="Model the agent runs on"
              value={card.model ?? card.models[0]}
              onChange={(e) => setCardModel(itemId, e.target.value)}
              className="h-7 w-full min-w-0 max-w-full rounded-md border border-hair bg-sf px-1.5 text-[12px] text-t1 focus:outline-none focus-visible:ring-2 focus-visible:ring-ac/40 max-md:h-11"
            >
              {[...new Set([...(card.model ? [card.model] : []), ...card.models])].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            (card.model ?? <span className="text-t3">none yet: pick one on its page</span>)
          )}
        </Row>
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
        {/* AG02: the tools the ask named that the agent did not get, and why. */}
        {card.notAdded && card.notAdded.length > 0 && (
          <Row label="Not added">
            <ul className="space-y-0.5">
              {card.notAdded.map((n) => (
                <li key={n.name}>
                  {n.name}: {n.reason}
                </li>
              ))}
            </ul>
          </Row>
        )}
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
        {/* AG04: what a revised card (or a change to an agent that exists) differs by; none is "no change", with nothing to apply. */}
        {card.changes && (
          <Row label="Changes">
            {card.changes.length ? (
              <ul data-testid="agent-changes" className="space-y-0.5">
                {card.changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            ) : (
              <span className="text-t3">{card.notAdded?.length ? 'No change: see Not added above.' /* ag1-int: never "already has" when a named tool was left out */ : 'No change: the agent already has what you asked.'}</span>
            )}
          </Row>
        )}
      </div>
      {card.state === 'failed' && card.error && (
        <p role="alert" className="mt-2 text-[12px] leading-snug text-rd [overflow-wrap:anywhere]">
          {card.base ? 'Couldn’t apply it' : 'Couldn’t create it'}: {card.error}
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {card.base ? (
          // AG04: a change to an agent that exists: Apply saves its draft and tests it; Publish only after a pass, through the eval gate.
          created ? (
            <>
              <span className={cn('min-w-0 text-[12px] font-semibold [overflow-wrap:anywhere]', card.smoke?.state === 'failed' || card.publish?.state === 'held' || card.publish?.state === 'failed' ? 'text-rd' : card.smoke?.state === 'passed' ? 'text-gn' : 'text-t2')}>
                Saved to its draft · {smokeLine(card.smoke)}
                {card.publish && ` · ${publishLine(card.publish)}`}
              </span>
              {card.smoke?.state === 'passed' && card.publish?.state !== 'published' && (
                <Button size="sm" variant="primary" disabled={card.publish?.state === 'publishing'} onClick={() => void publishAgentChange(itemId, card)} className="max-md:h-11 max-md:px-4">
                  {card.publish?.state === 'publishing' ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Publish
                </Button>
              )}
              {/* AG09: the smoke test again on the draft as it is (a credential picked since); nothing is saved. */}
              {card.smoke?.state !== 'testing' && (
                <Button size="sm" variant="ghost" onClick={() => void testAgentChange(itemId, card)} className="max-md:h-11 max-md:px-4">
                  Test again
                </Button>
              )}
              <a href={`/agents/${card.base.agentId}`} target="_blank" rel="noopener" className="flex min-h-7 items-center gap-0.5 text-[12px] font-semibold text-ac hover:underline max-md:min-h-11">
                Open <ExternalLink className="size-3" />
              </a>
            </>
          ) : (
            <>
              {card.changes?.length !== 0 && (
                <Button size="sm" variant="primary" disabled={busy || creating} onClick={() => void applyAgentChange(itemId, card)} className="max-md:h-11 max-md:px-4">
                  {creating && <Loader2 className="size-3.5 animate-spin" />}
                  {creating ? 'Applying…' : card.state === 'failed' ? 'Try again' : 'Apply to its draft'}
                </Button>
              )}
              <Button size="sm" variant="ghost" disabled={creating} onClick={() => dismissCard(itemId)} className="max-md:h-11 max-md:px-4">
                Dismiss
              </Button>
            </>
          )
        ) : created ? (
          <>
            {/* AG05: a spinner while the gate runs; a held or failed publish in the warning colour, with its cases. */}
            {publish?.state === 'publishing' && <Loader2 className="size-3.5 shrink-0 animate-spin text-viz-7" />}
            <span className={cn('min-w-0 text-[12px] font-semibold [overflow-wrap:anywhere]', publish?.state === 'held' || publish?.state === 'failed' ? 'text-warn' : smoke?.state === 'failed' ? 'text-rd' : !smoke || smoke.state === 'passed' ? 'text-gn' : 'text-t2')}>{createdLine}</span>
            {card.agentId && publish?.state === 'held' && (
              <a href={`/agents/${card.agentId}?tab=activity&view=evaluations`} target="_blank" rel="noopener" className="flex min-h-7 items-center text-[12px] font-semibold text-ac hover:underline max-md:min-h-11">
                See the cases
              </a>
            )}
            {card.agentId && needsCredential && (
              <a href={`/agents/${card.agentId}?tab=abilities`} target="_blank" rel="noopener" className="flex min-h-7 items-center text-[12px] font-semibold text-ac hover:underline max-md:min-h-11">
                Pick it
              </a>
            )}
            {card.agentId && (
              <a href={`/agents/${card.agentId}`} target="_blank" rel="noopener" className="flex min-h-7 items-center gap-0.5 text-[12px] font-semibold text-ac hover:underline max-md:min-h-11">
                Open <ExternalLink className="size-3" />
              </a>
            )}
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
