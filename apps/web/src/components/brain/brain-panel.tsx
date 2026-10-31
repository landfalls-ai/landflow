'use client';
/** "What Landflow knows" on Insights: the second brain's status, its facts, and how each detector has done (docs/second-brain.md). */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Brain, Search } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { DETECTOR_LABELS, type BrainFact, type BrainStatus } from '@/lib/shared/brain';
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
  const detectors = status.detectors.filter((d) => d.made || d.applied || d.dismissed || d.quiet > 1);
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
        {status.enabled ? `Model: ${status.model}` : 'Model: off'} · {status.events.toLocaleString()} events · {status.facts.toLocaleString()} facts · {status.profiles.toLocaleString()} profiles ·{' '}
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
            </tr>
          </thead>
          <tbody className="divide-y divide-hair text-t2">
            {detectors.map((d) => (
              <tr key={d.id}>
                <td className="py-1.5 text-t1">{DETECTOR_LABELS[d.id]}</td>
                <td className="py-1.5 text-right tabular-nums">{d.made}</td>
                <td className="py-1.5 text-right tabular-nums">{d.applied}</td>
                <td className="py-1.5 text-right tabular-nums">{d.dismissed}</td>
                <td className="py-1.5 text-right text-warn">{d.quiet > 1 ? 'quieted' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
