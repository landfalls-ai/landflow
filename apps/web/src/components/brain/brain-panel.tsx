'use client';
/**
 * "What Landflow knows" on Insights: the second brain's status, its facts, and how each detector has done, the flow
 * detectors among them, each with Run and Backtest (docs/second-brain.md): Backtest reruns the detector over the last
 * 30 days and shows a small card of how it would have fared against what people decided.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Brain, Search } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { BacktestResult, BrainFact, BrainStatus, DetectorId } from '@/lib/shared/brain';
import { Card } from '../shell/page-header';
import { Button } from '../ui/button';
import { Input, SectionLabel } from '../ui/inputs';

export function BrainPanel() {
  const router = useRouter();
  const [status, setStatus] = useState<BrainStatus>();
  const [facts, setFacts] = useState<BrainFact[]>();
  const [query, setQuery] = useState('');
  const [running, setRunning] = useState(false);
  const [creating, setCreating] = useState(false);
  const [canRun, setCanRun] = useState(true);
  const [runningOne, setRunningOne] = useState<DetectorId>();
  const [backtesting, setBacktesting] = useState<DetectorId>();
  const [backtests, setBacktests] = useState<Partial<Record<DetectorId, BacktestResult>>>({});

  const loadStatus = useCallback(() => {
    api<BrainStatus>('/api/brain/status')
      .then(setStatus)
      .catch(() => {});
  }, []);
  useEffect(loadStatus, [loadStatus]);

  useEffect(() => {
    const timer = setTimeout(() => {
      api<{ facts: BrainFact[] }>(`/api/brain/facts?q=${encodeURIComponent(query.trim())}&limit=20`)
        .then((r) => setFacts(r.facts))
        .catch(() => setFacts([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const run = async () => {
    setRunning(true);
    try {
      await api('/api/brain/run', { method: 'POST', json: { what: 'all' } });
      loadStatus();
      toast.success('Done');
    } catch (e) {
      if ((e as { status?: number }).status === 403) setCanRun(false);
      else toast.error((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const runOne = async (detector: DetectorId) => {
    setRunningOne(detector);
    try {
      const { detect } = await api<{ detect: { found: number; saved: number; flows?: Array<{ error?: string }> } }>('/api/brain/run', { method: 'POST', json: { what: 'detect', detector } });
      loadStatus();
      const failed = detect.flows?.find((f) => f.error)?.error;
      if (failed) toast.error(failed);
      else toast.success(detect.found ? `${detect.found} found, ${detect.saved} in the inbox` : 'Nothing found');
    } catch (e) {
      if ((e as { status?: number }).status === 403) setCanRun(false);
      else toast.error((e as Error).message);
    } finally {
      setRunningOne(undefined);
    }
  };

  const backtest = async (detector: DetectorId) => {
    setBacktesting(detector);
    try {
      const { backtest: result } = await api<{ backtest: BacktestResult }>('/api/brain/backtest', { method: 'POST', json: { detector } });
      setBacktests((all) => ({ ...all, [detector]: result }));
    } catch (e) {
      if ((e as { status?: number }).status === 403) setCanRun(false);
      else toast.error((e as Error).message);
    } finally {
      setBacktesting(undefined);
    }
  };

  const createAnalyst = async () => {
    setCreating(true);
    try {
      const { agent } = await api<{ agent: { id: string } }>('/api/brain/analyst', { method: 'POST' });
      router.push(`/agents/${agent.id}`);
    } catch (e) {
      toast.error((e as Error).message);
      setCreating(false);
    }
  };

  if (!status) return null;
  // Built-in detectors once they have a record; flow detectors always, so a new one shows up with its Run.
  const detectors = status.detectors.filter((d) => d.workflowId || d.made || d.applied || d.dismissed || d.quiet > 1);
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Brain className="size-3.5 text-viz-7" />
        <SectionLabel>What Landflow knows</SectionLabel>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" onClick={() => void createAnalyst()} loading={creating}>
            Create the Platform analyst
          </Button>
          {canRun && (
            <Button size="sm" onClick={() => void run()} loading={running}>
              Run now
            </Button>
          )}
        </div>
      </div>
      <p className="text-[12px] leading-relaxed text-t2">
        {status.enabled ? `Model: ${status.model}` : 'Model: off'} · {status.events.toLocaleString()} events · {status.facts.toLocaleString()} facts · {status.profiles.toLocaleString()} profiles · {(status.entities ?? 0).toLocaleString()} entities ·{' '}
        {status.open.toLocaleString()} open suggestions · last study {status.lastStudy ? timeAgo(status.lastStudy) : 'never'} · last detect {status.lastDetect ? timeAgo(status.lastDetect) : 'never'}
      </p>

      <label className="flex h-9 items-center gap-2 rounded-xl border border-bd bg-sf px-3 focus-within:border-ac">
        <Search className="size-3.5 text-t3" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search what it knows" aria-label="Search facts" className="h-auto border-0 bg-transparent p-0 shadow-none" />
      </label>
      {facts && facts.length === 0 && <p className="text-[12px] text-t3">{query ? 'No facts match.' : 'Nothing learned yet.'}</p>}
      {facts && facts.length > 0 && (
        <div className="divide-y divide-hair rounded-xl border border-hair">
          {facts.map((f) => (
            <div key={f.id} className="flex items-start gap-3 px-3 py-2 text-[12px]">
              <div className="w-[140px] shrink-0 truncate font-semibold text-t1" title={f.subjectName ?? f.subjectId}>
                {f.subjectName ?? f.subjectId}
                {f.subjectType === 'entity' && <span className="ml-1 font-normal text-t3">{f.subjectId.split('/')[0]}</span>}
              </div>
              <div className="w-[64px] shrink-0 text-t3">{f.kind}</div>
              <div className="min-w-0 flex-1 text-t2 [overflow-wrap:anywhere]">{f.statement}</div>
              <div className="shrink-0 text-t3">{timeAgo(f.lastSeen)}</div>
            </div>
          ))}
        </div>
      )}

      {detectors.length > 0 && (
        <table className="w-full text-left text-[12px]">
          <thead className="text-t3">
            <tr>
              <th className="py-1 font-medium">Detector</th>
              <th className="py-1 text-right font-medium">Made</th>
              <th className="py-1 text-right font-medium">Applied</th>
              <th className="py-1 text-right font-medium">Dismissed</th>
              <th className="py-1 text-right font-medium" />
              <th className="py-1 text-right font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-hair text-t2">
            {detectors.map((d) => (
              <tr key={d.id}>
                <td className="py-1.5 text-t1">
                  {d.workflowId ? (
                    <Link href={`/workflows/${d.workflowId}`} className="hover:underline">
                      {d.label}
                      <span className="text-t3">{d.active ? ' · flow' : ' · flow, not published'}</span>
                    </Link>
                  ) : (
                    d.label
                  )}
                </td>
                <td className="py-1.5 text-right tabular-nums">{d.made}</td>
                <td className="py-1.5 text-right tabular-nums">{d.applied}</td>
                <td className="py-1.5 text-right tabular-nums">{d.dismissed}</td>
                <td className="py-1.5 text-right text-warn">{d.quiet > 1 ? 'quieted' : ''}</td>
                <td className="py-1.5 text-right">
                  {canRun && (!d.workflowId || d.active) && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => void runOne(d.id)} loading={runningOne === d.id} disabled={Boolean(runningOne) && runningOne !== d.id}>
                        Run
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void backtest(d.id)} loading={backtesting === d.id} disabled={Boolean(backtesting) && backtesting !== d.id} title="Rerun it over the last 30 days and compare with what people decided">
                        Backtest
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {detectors.map((d) => backtests[d.id] && <BacktestCard key={d.id} result={backtests[d.id]!} onClose={() => setBacktests((all) => ({ ...all, [d.id]: undefined }))} />)}
    </Card>
  );
}

const percent = (n: number | null) => (n === null ? 'n/a' : `${Math.round(n * 100)}%`);

/** One backtest: precision and recall first, then the counts, and the findings and misses one to a line. One column, for a phone. */
function BacktestCard({ result, onClose }: { result: BacktestResult; onClose: () => void }) {
  const { counts } = result;
  const verdict = { hit: 'text-gn', 'false-alarm': 'text-warn', unknown: 'text-t3' } as const;
  return (
    <div className="space-y-2 rounded-xl border border-hair p-3 text-[12px]">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-t1">Backtest: {result.label}</span>
        <span className={result.gate.ok ? 'text-gn' : 'text-warn'}>{result.gate.ok ? 'passes' : 'fails'}</span>
        <button type="button" onClick={onClose} className="ml-auto text-t3 hover:text-t1">
          Close
        </button>
      </div>
      <p className="text-t3">
        {result.days} days, a point every {result.step === 1 ? 'day' : `${result.step} days`}, quiet {result.quiet}
        {result.quietGiven ? '' : ' (its own)'}
        {result.partial ? ' · stopped early' : ''}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-[18px] font-semibold tabular-nums text-t1">{percent(result.precision)}</div>
          <div className="text-t3">precision</div>
        </div>
        <div>
          <div className="text-[18px] font-semibold tabular-nums text-t1">{percent(result.recall)}</div>
          <div className="text-t3">recall</div>
        </div>
      </div>
      <p className="text-t2">
        {counts.findings} found: {counts.hits} hits, {counts.falseAlarms} false alarms, {counts.unknown} undecided · {counts.misses} missed, {counts.avoided} rightly left out
      </p>
      <p className="text-t3">{result.gate.reason}</p>
      {result.findings.length > 0 && (
        <ul className="space-y-1">
          {result.findings.slice(0, 12).map((f) => (
            <li key={f.fingerprint} className="text-t2">
              <span className={verdict[f.verdict]}>{f.verdict === 'false-alarm' ? 'false alarm' : f.verdict}</span> · {f.title} <span className="text-t3">({f.decision}, {f.points}×)</span>
            </li>
          ))}
        </ul>
      )}
      {result.missed.some((m) => m.wanted) && (
        <ul className="space-y-1">
          {result.missed
            .filter((m) => m.wanted)
            .slice(0, 8)
            .map((m) => (
              <li key={m.proposalId} className="text-t2">
                <span className="text-warn">missed</span> · {m.title} <span className="text-t3">({m.decision})</span>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
