'use client';
/**
 * The AI page's cache card (docs/llm-gateway.md, "The AI page"): how much of the prompt came from the provider's cache
 * over the period, what it saved, and the agents that miss most, with why. Numbers only, never prompt text.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { cacheCardState } from '@/lib/client/ai-console';
import { cacheHeadline, hitPercent, missesLead } from '@/lib/client/ai-forecast';
import { MISS_REASON_WORDS } from '@/lib/client/run-spend';
import { formatTokens } from '@/lib/shared/ai-usage';
import type { AiCacheReport } from '@/lib/shared/ai-cache';
import { Card } from '@/components/shell/page-header';
import { SectionLabel } from '@/components/ui/inputs';

const REFRESH_MS = 60_000;

/**
 * `query` is the page's own (period, custom days and every filter, `reportQuery`), so the card is narrowed as the report
 * is. Nothing is asked while `ready` is false (a custom range that is incomplete or bad); the last card stays, dimmed.
 */
export function AiCacheCard({ query, ready }: { query: string; ready: boolean }) {
  const [loaded, setLoaded] = useState<{ query: string; report: AiCacheReport }>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!cacheCardState(undefined, query, ready).ask) return;
    let current = true;
    const load = (background: boolean) =>
      api<AiCacheReport>(`/api/insights/ai/cache?${query}`, { background })
        .then((r) => {
          if (current) {
            setLoaded({ query, report: r });
            setFailed(false);
          }
        })
        .catch(() => current && setFailed(true));
    load(false);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load(true);
    }, REFRESH_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [query, ready]);
  if (failed && !loaded) return null;
  // The last card stays on screen, dimmed, while a changed view (another range or filter) loads or can't be asked.
  const shown = loaded?.report;
  const { stale } = cacheCardState(loaded?.query, query, ready);
  return (
    <div data-testid="ai-cache-card" className={stale ? 'opacity-60 transition-opacity' : 'transition-opacity'} aria-busy={stale}>
      <Card className="px-4 py-3.5">
        <div className="mb-3 flex items-center gap-3">
          <SectionLabel>Prompt cache</SectionLabel>
          <span className="text-[12px] text-t3">in this period</span>
        </div>
        {!shown ? (
          <div className="h-16 rounded-xl bg-acdim animate-pulse-soft" />
        ) : (
          <>
            <p className="text-[15px] font-semibold text-t1" data-testid="cache-headline">
              {cacheHeadline(shown)}
            </p>
            {shown.cache.hitRate !== undefined && (
              <p className="mt-0.5 text-[12px] text-t3">
                {formatTokens(shown.cache.readTokens)} read · {formatTokens(shown.cache.writeTokens)} written · {shown.cache.missCalls} {shown.cache.missCalls === 1 ? 'miss' : 'misses'}{shown.missRuns > 0 && ` in ${shown.missRuns} of ${shown.runs} ${shown.runs === 1 ? 'run' : 'runs'}`}
              </p>
            )}
            {shown.agentNode.calls > 0 && (
              <p className="mt-2 text-[13px] text-t2" data-testid="cache-agent-node">
                The AI Agent node asks for no cache: {shown.agentNode.calls.toLocaleString('en-US')} of its Anthropic call{shown.agentNode.calls === 1 ? '' : 's'} sent {formatTokens(shown.agentNode.uncachedTokens)} tokens uncached.
              </p>
            )}
            {shown.agents.length > 0 && (
              <div className="mt-3 border-t border-hair pt-2">
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-t3">Most uncached input</p>
                <ul className="divide-y divide-hair">
                  {shown.agents.map((agent) => (
                    <li key={agent.key} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-[13px]" data-testid="cache-agent">
                      <span className="min-w-0 flex-1 truncate text-t1 max-md:basis-full">{agent.label}</span>
                      <span className="tabular-nums text-t2">{formatTokens(agent.uncachedTokens)} uncached</span>
                      <span className="tabular-nums text-t3">{agent.hitRate === undefined ? 'no cache numbers' : `${hitPercent(agent.hitRate)} hit`}</span>
                      {agent.missReasons.length > 0 && <span className="basis-full text-[12px] text-t3">{missesLead(agent)}: {agent.missReasons.map((r) => MISS_REASON_WORDS[r]).join('; ')}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {shown.reasonsPartial && <p className="mt-2 text-[12px] text-t3">Miss reasons cover the last 30 days at most: prompt splits are not kept longer.</p>}
            {shown.truncated && <p className="mt-2 text-[12px] text-t3">Only the newest calls of a very large period are counted.</p>}
          </>
        )}
      </Card>
    </div>
  );
}
