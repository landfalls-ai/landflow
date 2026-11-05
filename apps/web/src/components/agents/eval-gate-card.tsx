'use client';
/**
 * Eval gate: test cases an agent is checked against before a publish. "Run now" scores the draft; a publish whose draft scores
 * below 3 / 5, or half a point under the published version, is held until the person publishes anyway or fixes the draft.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Play, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { GATE_MAX_DROP, GATE_MIN_AVERAGE, type AgentEvalCase, type AgentEvalRun } from '@/lib/shared/agent-eval';
import { Button } from '../ui/button';
import { Input, Textarea } from '../ui/inputs';
import { Section } from './dialog';

export function EvalGateCard({ agentId }: { agentId: string }) {
  const [cases, setCases] = useState<AgentEvalCase[]>();
  const [runs, setRuns] = useState<AgentEvalRun[]>([]);
  const [input, setInput] = useState('');
  const [expected, setExpected] = useState('');
  const [running, setRunning] = useState(false);

  const load = useCallback(() => {
    api<{ cases: AgentEvalCase[]; runs: AgentEvalRun[] }>(`/api/agents/${agentId}/eval-gate`)
      .then((r) => {
        setCases(r.cases);
        setRuns(r.runs);
      })
      .catch((e: Error) => toast.error(e.message));
  }, [agentId]);

  useEffect(load, [load]);

  const add = async () => {
    try {
      await api(`/api/agents/${agentId}/eval-gate`, { method: 'POST', json: { input, ...(expected.trim() && { expected }) } });
      setInput('');
      setExpected('');
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const remove = async (caseId: string) => {
    await api(`/api/agents/${agentId}/eval-gate`, { method: 'DELETE', json: { caseId } }).catch((e: Error) => toast.error(e.message));
    load();
  };

  const run = async () => {
    setRunning(true);
    try {
      const { run: done } = await api<{ run: AgentEvalRun }>(`/api/agents/${agentId}/eval-gate`, { method: 'PUT', json: {} });
      toast.success(`The draft averages ${done.average.toFixed(1)} / 5`);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const latest = runs[0];

  return (
    <Section
      icon={<ShieldCheck className="size-4" />}
      title="Eval gate"
      description={`Questions this agent must keep answering well. Publishing runs them on the draft and holds it if it averages under ${GATE_MIN_AVERAGE} / 5 or ${GATE_MAX_DROP} below the published version.`}
    >
      {!cases && <div className="h-[80px] rounded-[10px] border border-hair bg-wl animate-pulse-soft" />}
      {cases && (
        <div className="space-y-3">
          {cases.map((c) => {
            const result = latest?.results.find((r) => r.caseId === c.id);
            return (
              <div key={c.id} className="rounded-[10px] border border-hair bg-wl px-3 py-2 text-[13px]">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-t1">{c.input}</div>
                    {c.expected && <div className="text-[12px] text-t3">Expected: {c.expected}</div>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {result && <span className="font-mono text-[12px] text-t2">{result.score} / 5</span>}
                    <Button size="icon-sm" variant="ghost" aria-label="Remove test case" onClick={() => void remove(c.id)}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
                {result && <div className="mt-1 text-[12px] text-t3">{result.error ? `Could not run: ${result.error}` : result.reasoning}</div>}
              </div>
            );
          })}
          <div className="space-y-2">
            <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="A question to ask the agent" />
            <Textarea value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="The answer it should give (optional: without one, the reply is judged for helpfulness)" rows={2} />
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={!input.trim()} onClick={() => void add()}>
                Add test case
              </Button>
              <Button size="sm" disabled={!cases.length || running} onClick={() => void run()}>
                {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Run on the draft
              </Button>
              {latest && (
                <span className="text-[12px] text-t3">
                  Last run: {latest.average.toFixed(1)} / 5 on {latest.version === 'draft' ? 'the draft' : `v${latest.version}`}, {timeAgo(latest.createdAt)}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}
