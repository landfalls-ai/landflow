'use client';
/**
 * Evaluations tab: online grading of the agent's conversations. An LLM judge scores a sample of finished
 * sessions against a rubric (1–5); the scores, their 30-day trend and the flagged low ones show here.
 * "Grade a session" scores one recent session now, whatever the sample rate.
 */
import { useCallback, useEffect, useState } from 'react';
import { Gauge, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { SessionSummary } from '@/lib/shared/agents';
import type { OnlineEvalReport } from '@/lib/shared/evaluations';
import { OnlineEvalPanel, type OnlineEvalPatch } from '../evaluations/online-eval-panel';
import { Button } from '../ui/button';
import { Popover } from '../ui/popover';
import { Section } from './dialog';

function GradeSession({ agentId, onGraded }: { agentId: string; onGraded: () => void }) {
  const [sessions, setSessions] = useState<SessionSummary[]>();
  const [grading, setGrading] = useState<string>();

  const grade = async (sessionId: string, close: () => void) => {
    setGrading(sessionId);
    try {
      const { score } = await api<{ score: { score: number } }>(`/api/agents/${agentId}/evaluations`, { method: 'POST', json: { sessionId } });
      toast.success(`Graded ${score.score} / 5`);
      close();
      onGraded();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setGrading(undefined);
    }
  };

  return (
    <Popover
      trigger={({ open, toggle }) => (
        <Button
          size="sm"
          variant="outline"
          aria-expanded={open}
          onClick={() => {
            if (!open && !sessions)
              api<{ sessions: SessionSummary[] }>(`/api/agents/${agentId}/sessions`)
                .then((r) => setSessions(r.sessions.filter((s) => s.turns > 0).slice(0, 12)))
                .catch(() => setSessions([]));
            toggle();
          }}
        >
          <Sparkles className="size-3.5" /> Grade a session
        </Button>
      )}
    >
      {(close) => (
        <div className="w-[300px]">
          <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Recent sessions</div>
          {!sessions && <div className="px-2.5 py-3 text-[12px] text-t3">Loading…</div>}
          {sessions && !sessions.length && <div className="px-2.5 py-3 text-[12px] text-t3">No sessions with a reply yet.</div>}
          {sessions?.map((s) => (
            <button
              key={s.id}
              disabled={Boolean(grading)}
              onClick={() => void grade(s.id, close)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-t1 hover:bg-acdim disabled:opacity-60"
            >
              <span className="min-w-0 flex-1 truncate">{s.title || 'Untitled session'}</span>
              {grading === s.id ? <Loader2 className="size-3.5 animate-spin text-t3" /> : <span className="shrink-0 text-[11px] text-t3">{timeAgo(s.updatedAt)}</span>}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

export function EvaluationsTab({ agentId }: { agentId: string }) {
  const [report, setReport] = useState<OnlineEvalReport>();
  const [error, setError] = useState<string>();

  const load = useCallback(() => {
    api<{ report: OnlineEvalReport }>(`/api/agents/${agentId}/evaluations`)
      .then((r) => setReport(r.report))
      .catch((e: Error) => setError(e.message));
  }, [agentId]);
  useEffect(load, [load]);

  const save = async (patch: OnlineEvalPatch) => {
    try {
      const r = await api<{ report: OnlineEvalReport }>(`/api/agents/${agentId}/evaluations`, { method: 'PUT', json: patch });
      setReport(r.report);
      toast.success('Saved grading settings');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <Section
      icon={<Gauge className="size-4" />}
      title="Online evaluations"
      description="Grade a sample of finished conversations with an LLM judge, follow the score over time and catch low-scoring replies."
    >
      {error && <p className="text-[13px] text-rd">{error}</p>}
      {!report && !error && <div className="h-[220px] rounded-[10px] border border-hair bg-wl animate-pulse-soft" />}
      {report && (
        <OnlineEvalPanel
          report={report}
          onSave={save}
          actions={<GradeSession agentId={agentId} onGraded={load} />}
          linkOf={(score) => (score.sessionId ? { href: `/agents/${agentId}?tab=sessions&session=${score.sessionId}`, label: 'Open session' } : undefined)}
        />
      )}
    </Section>
  );
}
