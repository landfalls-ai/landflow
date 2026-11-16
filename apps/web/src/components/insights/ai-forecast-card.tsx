'use client';
/**
 * The AI page's month-end forecast (docs/llm-gateway.md, "The AI page"): where this month's spend is heading, and each
 * cap or budget the viewer may see with the day it is reached, or that it stays under.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { exactOf, capOutlook, forecastNote, forecastRange } from '@/lib/client/ai-forecast';
import { monthEndOf } from '@/lib/shared/ai-forecast';
import type { AiForecastReport } from '@/lib/shared/ai-spend';
import { cn } from '@/lib/utils';
import { Card } from '@/components/shell/page-header';
import { SectionLabel } from '@/components/ui/inputs';

const REFRESH_MS = 60_000;
const TONE = { ok: 'text-t2', near: 'text-warn', full: 'text-rd' } as const;

export function AiForecastCard() {
  const [report, setReport] = useState<AiForecastReport>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const load = (background: boolean) =>
      api<AiForecastReport>('/api/insights/ai/forecast', { background })
        .then((r) => {
          setReport(r);
          setFailed(false);
        })
        .catch(() => setFailed(true));
    load(false);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load(true);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  if (failed && !report) return null;
  const monthEnd = report ? monthEndOf(`${report.month}-01`) : '';
  return (
    <div data-testid="ai-forecast-card">
      <Card className="px-4 py-3.5">
        <div className="mb-3 flex items-center gap-3">
          <SectionLabel>Forecast to month end</SectionLabel>
          <span className="text-[12px] text-t3">this month, whatever the period above</span>
        </div>
        {!report ? (
          <div className="h-16 rounded-xl bg-acdim animate-pulse-soft" />
        ) : (
          <>
            <p className="text-[22px] font-semibold tabular-nums text-t1" data-testid="forecast-range">
              {forecastRange(report.total, monthEnd)}
            </p>
            <p className="mt-1 text-[13px] text-t2">{forecastNote(report.total)}</p>
            {report.caps.length > 0 && (
              <ul className="mt-3 divide-y divide-hair border-t border-hair">
                {report.caps.map((cap) => {
                  const outlook = capOutlook(cap, monthEnd);
                  return (
                    <li key={cap.capId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-[13px]" data-testid="forecast-cap">
                      <span className="min-w-0 flex-1 truncate text-t1 max-md:basis-full" title={cap.subject}>
                        {cap.subject}
                        <span className="ml-2 text-[12px] text-t3">{cap.metric === 'cost' ? 'Cost' : 'Tokens'} {cap.period === 'day' ? 'per day' : 'per month'}</span>
                      </span>
                      <span className="tabular-nums text-t3">
                        {exactOf(cap.metric, cap.used)} of {exactOf(cap.metric, cap.max)}
                      </span>
                      <span className={cn('tabular-nums', TONE[outlook.tone])}>{outlook.text}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
