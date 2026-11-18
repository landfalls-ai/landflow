'use client';
/**
 * The agent Spotlight designed, as a card to review (docs/assistant.md "Agents from Spotlight"): who it is, what it does,
 * the model, the tools (each with "asks first" when a person approves its calls), the knowledge, whether it follows the
 * approved practices, the guardrails in words and its test cases; then Create (on an empty canvas, with the flow that runs
 * it) or Dismiss. Created, it is a draft with a link to its page.
 */
import { useMemo, useState } from 'react';
import { Check, ChevronDown, ExternalLink, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { attachedLine, knowledgeLine, publishLine, reuseLine, smokeLine, type AgentCard as AgentCardData } from '@/lib/shared/agent-card'; // AG04: publishLine AG19: attachedLine, reuseLine
import { cardBubbles, type Bubble } from '@/lib/shared/agent-bubbles'; // AG19:
import { useEditor } from '../store'; // the node titles the bubbles read
import { BubbleDiagram } from '../../canvas/bubble-view'; // AG19: the card draws the agent as bubbles, one look with the canvas
import type { AgentConfig } from '@/lib/shared/agents';
import { AgentAvatar } from '../../agents/avatar';
import { Button } from '../../ui/button';
import { applyAgentChange, cardTool, createFromCard, dismissCard, publishAgentChange, setCardModel, testAgentChange, testedThisLoad, useExistingAgent } from './agent-ask'; // AG19: cardTool, useExistingAgent // AG02: setCardModel; AG04: applyAgentChange, publishAgentChange; AG09: testAgentChange
import { stillLeft, useAgentDraft } from '@/lib/client/agent-change'; // AG09:
import { useAssistant } from '../assistant';
import { isStaleCard } from '../spotlight-history'; // AG11:

const CASES_SHOWN = 2;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-[12px] leading-snug">
      <span className="w-[68px] shrink-0 text-t3">{label}</span>
      <div className="min-w-0 flex-1 text-t1 [overflow-wrap:anywhere]">{children}</div>
    </div>
  );
}

/** AG19: the card's own detail line for an open bubble (what a hover title cannot hold on a phone): a tool's node and operation, the knowledge base's line, the model's why. */
/**
 * A Left line as the person reads it: `sqlite: pick a sqlite credential (you have “Sales DB”)` says the node's title and no slot
 * id: `SQLite: pick a credential (you have “Sales DB”)`. The stored line (the design route's) is what `stillLeft` matches, so only
 * the display changes.
 */
export function plainLeft(line: string, tools: ReadonlyArray<{ name: string; type?: string }>, titleOf: (type: string) => string | undefined): string {
  const m = /^(.+?): pick an? (.+?) credential(.*)$/.exec(line);
  if (!m) return line;
  const tool = tools.find((t) => t.name === m[1]);
  const title = (tool?.type && titleOf(tool.type)) || m[1]!.replace(/_/g, ' ');
  return `${title}: pick a credential${m[3]}`;
}

function bubbleDetail(card: AgentCardData, b: Bubble, left: string[], ofReused = false): string {
  if (b.slot === 'model') {
    if (ofReused) return card.model ? `${card.model} · the reused agent’s model` : 'No model set on the reused agent.';
    if (!card.model) return card.state === 'designed' ? 'No model on this host: pick one in the select below.' : 'No model yet: pick one on its page.';
    return `${card.model} · ${card.modelWhy === 'asked' ? 'you asked for it' : card.modelWhy === 'unavailable' ? (card.modelNote ?? 'the model you asked for is not available here') : 'this host’s model'}`;
  }
  if (b.slot === 'memory') return `${b.label}: it remembers ${b.label.toLowerCase().startsWith('across') ? 'across conversations' : 'this conversation only'}.`;
  if (b.kind === 'knowledge') return card.attached ? attachedLine(card.attached) : card.knowledgeSetup ? knowledgeLine(card.knowledgeSetup) : `the “${b.label}” knowledge base`;
  const tool = card.tools.find((t) => t.name === b.label);
  const credential = left.filter((l) => l.toLowerCase().startsWith(`${(b.callName ?? b.label).toLowerCase()}:`)).map((l) => l.slice(l.indexOf(':') + 1).trim().replace(/^pick an? .+? credential/, 'pick a credential'));
  return [`${tool?.type ?? 'tool'}${tool?.operation ? ` · ${tool.operation}` : ''}`, tool?.requireApproval ? 'asks first' : tool?.writes ? 'writes' : 'reads', ...credential].join(' · ');
}

export function AgentCardView({ itemId, card, busy = false, earlier = false }: { itemId: string; card: AgentCardData; busy?: boolean; earlier?: boolean }) {
  const [allCases, setAllCases] = useState(false);
  const config = card.config as Partial<AgentConfig>;
  const created = card.state === 'created';
  const creating = card.state === 'creating';
  const cases = allCases ? card.cases : card.cases.slice(0, CASES_SHOWN);
  // AG11: a card brought back from history offers Publish only after Test again passed in this page load.
  const followed = card.base?.agentId ?? (created ? card.agentId : undefined); // AG12: a created card follows its agent too (the pick on the agent page opened by Pick it)
  const draft = useAgentDraft(followed); // AG09: a change card's Left row is what the agent's draft still lacks
  const left = [...(followed ? stillLeft(card.needs, draft) : card.needs) /* AG09: */, ...card.missing.map((m) => `Not available here: ${m}`)];
  // Integration (sb3): after Create the line is SB18's smoke line, live from the agent's row ("tested, 1 of 1 passed · published").
  const row = useAssistant((s) => (card.agentId ? s.agents.find((a) => a.agentId === card.agentId) : undefined));
  const smoke = row?.smoke ?? card.smoke;
  // AG05: what the row says while the eval gate runs and after (held stays); the same words, from `publishLine`.
  const publish = row ? row.publish : card.publish;
  const tested = smoke ? `${smokeLine(smoke)}${smoke.state === 'passed' && smoke.reason ? ` · ${smoke.reason}` : ''}` : 'Created as a draft';
  const createdLine = publish?.state === 'publishing' ? publishLine(publish) : `${tested}${publish && publish.state !== 'published' ? ` · ${publishLine(publish)}` : row?.state === 'published' ? ' · published' : ''}`;
  const needsCredential = smoke?.state === 'untested' && Boolean(smoke.reason?.startsWith('needs a credential'));
  // AG19: the agent as bubbles (the person: "Bubbles there too"): the proposed agent's, or, while a reuse that fits whole is offered, the reused agent's (read as the Agents page keeps it).
  const [openId, setOpenId] = useState<string>();
  const reusing = Boolean(card.reuse && card.state === 'designed' && !card.base);
  // Wave ag4 carryover (live pass, asks.md B): a reuse that lacks something (an IOC tool, the model asked for) is only the
  // closest: the diagram draws the proposed agent, the reuse row above it still offers the closest; a full fit draws it.
  const drawReused = reusing && !card.reuse!.gaps?.length;
  const reused = useAgentDraft(drawReused ? card.reuse!.agentId : undefined);
  // A tool bubble reads as the node it is ("Extract IOCs"), never the agent's tool id: the titles are the editor's node catalog's.
  const nodeTypes = useEditor((s) => s.nodeTypes);
  const titled = <T extends { type?: string }>(tools: T[]): Array<T & { title?: string }> => tools.map((t) => ({ ...t, ...(t.type && nodeTypes[t.type] && { title: nodeTypes[t.type].descriptor.displayName }) }));
  const bubbles = useMemo(() => {
    if (drawReused) {
      if (!reused) return [];
      const m = reused.model as { provider?: string; model?: string } | undefined;
      const tools = titled(((reused.tools as Array<Parameters<typeof cardTool>[0]> | undefined) ?? []).filter((t) => t.type !== 'knowledge').map(cardTool));
      const kb = ((reused.tools as Array<{ type: string; collection?: string; name?: string }> | undefined) ?? []).find((t) => t.type === 'knowledge');
      return cardBubbles({ ...(m?.model && { model: m.provider ? `${m.provider}/${m.model}` : m.model }), tools, ...(kb && { knowledge: kb.collection || kb.name }), config: reused });
    }
    return cardBubbles({ ...card, tools: titled(card.tools) });
  }, [drawReused, reused, card, nodeTypes]); // eslint-disable-line react-hooks/exhaustive-deps
  const diagramName = drawReused ? card.reuse!.name : card.name;
  const open = bubbles.find((b) => b.id === openId);
  // A reused agent's bubble detail reads the reused agent, never the proposed design.
  const detailCard = useMemo<AgentCardData>(() => {
    if (!drawReused || !reused) return card;
    const m = reused.model as { provider?: string; model?: string } | undefined;
    const rt = (reused.tools as Array<Parameters<typeof cardTool>[0] & { collection?: string }> | undefined) ?? [];
    const kb = rt.find((t) => t.type === 'knowledge');
    const { modelWhy: _w, modelNote: _n, attached: _a, knowledgeSetup: _k, knowledge: _kn, model: _m, ...rest } = card;
    return { ...rest, tools: rt.filter((t) => t.type !== 'knowledge').map(cardTool), ...(m?.model && { model: m.provider ? `${m.provider}/${m.model}` : m.model }), ...(kb && { knowledge: kb.collection || ('name' in kb ? kb.name : undefined) }) } as AgentCardData;
  }, [drawReused, reused, card]);
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
      {/* AG19: the reuse row: an agent that already does the job. Use it first; Create anyway is the second choice, never the default. */}
      {reusing && card.reuse && (
        <div data-testid="agent-reuse" className="mt-2 rounded-lg border border-acbd bg-acdim p-2">
          <p className="text-[12px] leading-snug text-t1 [overflow-wrap:anywhere]">{reuseLine(card.reuse)}</p>
          {/* A reuse with gaps is only the closest: Create is the primary button and Use is the second choice (asks first and autonomous alike). */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {card.reuse.gaps.length > 0 ? (
              <>
                <Button size="sm" variant="primary" disabled={busy || creating} onClick={() => void createFromCard(itemId, card)} className="max-md:h-11 max-md:px-4">
                  {creating && <Loader2 className="size-3.5 animate-spin" />}
                  {creating ? 'Creating…' : card.starter ? 'Create agent and flow' : 'Create agent'}
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void useExistingAgent(itemId, card)} className="max-md:h-11 max-md:px-4">
                  Use {card.reuse.name} anyway
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="primary" disabled={busy} onClick={() => void useExistingAgent(itemId, card)} className="max-md:h-11 max-md:px-4">
                  Use {card.reuse.name}
                </Button>
                <Button size="sm" variant="outline" disabled={busy || creating} onClick={() => void createFromCard(itemId, card)} className="max-md:h-11 max-md:px-4">
                  Create anyway
                </Button>
              </>
            )}
          </div>
        </div>
      )}
      {/* AG19: the agent as bubbles, drawn by the canvas's own component; each bubble opens its detail on one line under the diagram. */}
      {bubbles.length > 0 && (
        <div className="mt-2">
          <BubbleDiagram agentName={diagramName} bubbles={bubbles} {...(openId && { openId })} onOpen={(b) => setOpenId((id) => (id === b.id ? undefined : b.id))} />
          <p data-testid="bubble-detail" aria-live="polite" className="mt-1 min-h-4 text-[11.5px] leading-snug text-t2 [overflow-wrap:anywhere]">
            {open ? bubbleDetail(detailCard, open, drawReused ? [] : left, drawReused) : ''}
          </p>
        </div>
      )}
      {/* AG02: a designed card's model is a select of the models this host offers (the host's builder model first); a change redraws the model bubble. */}
      {card.state === 'designed' && !drawReused && card.models && card.models.length > 1 && (
        <label className="mt-1.5 flex items-center gap-2 text-[12px] text-t3">
          <span className="shrink-0">Change model</span>
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
        </label>
      )}
      <div className="mt-2 space-y-1.5">
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
        {/* AG13: what will be indexed, from where, how it is searched, and after Create how the indexing went; a card without it reads as before. */}
        {card.knowledgeSetup ? (
          <Row label="Knowledge">
            <span data-testid="agent-knowledge" className={cn(card.knowledgeSetup.problem || card.knowledgeSetup.state === 'failed' ? 'text-rd' : card.knowledgeSetup.state === 'indexed' && 'text-gn')}>{knowledgeLine(card.knowledgeSetup)}</span>
            {card.knowledgeSetup.files && card.knowledgeSetup.files.length > 0 && (
              <details data-testid="agent-knowledge-files" className="group mt-0.5">
                <summary className="inline-flex min-h-5 cursor-pointer items-center gap-0.5 text-[11.5px] font-semibold text-ac hover:underline max-md:min-h-9">
                  {card.knowledgeSetup.fileCount ?? card.knowledgeSetup.files.length} file{(card.knowledgeSetup.fileCount ?? card.knowledgeSetup.files.length) === 1 ? '' : 's'}
                  <ChevronDown className="size-3 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
                </summary>
                <ul className="mt-0.5 space-y-0.5 text-t2">
                  {card.knowledgeSetup.files.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                  {(card.knowledgeSetup.fileCount ?? 0) > card.knowledgeSetup.files.length && <li>and {(card.knowledgeSetup.fileCount ?? 0) - card.knowledgeSetup.files.length} more</li>}
                </ul>
              </details>
            )}
          </Row>
        ) : (
          card.knowledge && <Row label="Knows">The “{card.knowledge}” knowledge base</Row>
        )}
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
        {left.length > 0 && <Row label="Left">{left.slice(0, 4).map((l) => plainLeft(l, card.tools, (type) => nodeTypes[type]?.descriptor.displayName)).join('; ')}</Row>}
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
      {card.state === 'failed' && card.error && !isStaleCard(card) && (
        <p role="alert" className="mt-2 text-[12px] leading-snug text-rd [overflow-wrap:anywhere]">
          {card.base ? 'Couldn’t apply it' : 'Couldn’t create it'}: {card.error}
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {isStaleCard(card) ? (
          // AG11: a card brought back without what Create needs (too big to keep, or another workflow's): it says so and offers nothing.
          <span className="min-w-0 text-[12px] font-semibold text-t2 [overflow-wrap:anywhere]">{card.error}</span>
        ) : created && card.error ? (
          // AG11: its agent was looked up when the conversation came back, and is gone.
          <span className="min-w-0 text-[12px] font-semibold text-warn [overflow-wrap:anywhere]">{card.error}</span>
        ) : card.base ? (
          // AG04: a change to an agent that exists: Apply saves its draft and tests it; Publish only after a pass, through the eval gate.
          created ? (
            <>
              <span className={cn('min-w-0 text-[12px] font-semibold [overflow-wrap:anywhere]', card.smoke?.state === 'failed' || card.publish?.state === 'held' || card.publish?.state === 'failed' ? 'text-rd' : card.smoke?.state === 'passed' ? 'text-gn' : 'text-t2')}>
                Saved to its draft · {smokeLine(card.smoke)}
                {card.publish && ` · ${publishLine(card.publish)}`}
              </span>
              {card.smoke?.state === 'passed' && card.publish?.state !== 'published' && (!earlier || testedThisLoad(itemId)) && (
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
            {/* AG19: with a reuse offered, Create is the reuse row's "Create anyway" (never the default): only Dismiss stays here. */}
            {!reusing && (
              <Button size="sm" variant="primary" disabled={busy || creating} onClick={() => void createFromCard(itemId, card)} className="max-md:h-11 max-md:px-4">
                {creating && <Loader2 className="size-3.5 animate-spin" />}
                {creating ? 'Creating…' : card.state === 'failed' ? 'Try again' : card.starter ? 'Create agent and flow' : 'Create agent'}
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={creating} onClick={() => dismissCard(itemId)} className="max-md:h-11 max-md:px-4">
              Dismiss
            </Button>
          </>
        )}
      </div>
      {/* AG19: what the design read of the tenant, muted. */}
      {card.catalog && card.catalog.length > 0 && (
        <p data-testid="agent-looked-at" className="mt-1.5 text-[11px] leading-snug text-t3 [overflow-wrap:anywhere]">
          Looked at: {card.catalog.map((c) => `${c.tool}${c.count !== undefined ? ` ${c.count}` : ''}`).join(', ')}
        </p>
      )}
    </div>
  );
}
