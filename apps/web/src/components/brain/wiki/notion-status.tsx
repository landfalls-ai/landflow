'use client';
/**
 * The Brain page's Notion status (docs/second-brain.md#the-brain-page): for the open page's project, when it is linked to Notion,
 * a chip in the title bar ("In Notion · synced 2 minutes ago", amber for problems, red when Notion refused the key or stopped
 * seeing the page) and the link's problems for the Problems panel's "Notion sync" group. The words are lib/client/notion-brain.ts's,
 * the Brain card's and Spotlight's too. A project with no link shows nothing. Words and ids only: never a key, never page text.
 */
import { useCallback, useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { actOnNotionProblem, actionsFor, notionLink, notionProblems, PROBLEM_ACTION_LABELS, statusSentence, statusTone } from '@/lib/client/notion-brain';
import { LINK_STATUS_LABELS, type LinkProblemView, type LinkView, type ProblemAction } from '@/lib/shared/notion-brain';
import { Button } from '../../ui/button';

export interface NotionBrain {
  /** The project's link, when it has one. */
  view?: LinkView;
  problems: LinkProblemView[];
  reload: () => Promise<void>;
}

/** The link and its problems for a project (none without one): every 30 s, every 3 s while it copies, nothing while the tab is hidden. */
export function useNotionBrain(projectId: string | undefined): NotionBrain {
  const [view, setView] = useState<LinkView>();
  const [problems, setProblems] = useState<LinkProblemView[]>([]);
  const load = useCallback(async () => {
    if (!projectId) {
      setView(undefined);
      setProblems([]);
      return;
    }
    try {
      const next = await notionLink(projectId, true);
      if (!next.linked) {
        setView(undefined);
        setProblems([]);
        return;
      }
      setView(next);
      setProblems(await notionProblems(projectId, true).catch(() => []));
    } catch {
      // A project the viewer cannot read the link of: no chip.
      setView(undefined);
      setProblems([]);
    }
  }, [projectId]);
  useEffect(() => {
    setView(undefined);
    setProblems([]);
    void load();
  }, [load]);
  const copying = view?.status === 'setting_up' || view?.status === 'copying';
  useEffect(() => {
    if (!projectId) return;
    const tick = () => {
      if (!document.hidden) void load();
    };
    const timer = setInterval(tick, copying ? 3_000 : 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [projectId, copying, load]);
  return { view, problems, reload: load };
}

const TONES = {
  ok: 'border-hair text-t2',
  warning: 'border-warnbd bg-warndim text-warn',
  danger: 'border-rdbd bg-rddim text-rd',
  muted: 'border-hair text-t3',
} as const;

/** "In Notion · synced 2 minutes ago · 0 waiting · 1 problem" while it syncs; the status's own sentence otherwise. */
export function chipText(view: LinkView, now?: number): string {
  const sentence = statusSentence(view, now);
  const label = LINK_STATUS_LABELS[view.status];
  return view.status === 'active' ? `In Notion${sentence.slice(label.length)}` : sentence;
}

/** The title bar's chip; `onClick` opens the Problems panel. Nothing when the project is not linked. */
export function NotionChip({ view, onClick, className }: { view?: LinkView; onClick?: () => void; className?: string }) {
  if (!view) return null;
  const tone = statusTone(view);
  const [head, ...rest] = chipText(view).split(' · ');
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="notion-chip"
      data-tone={tone}
      title={chipText(view)}
      className={cn('flex h-7 max-w-[300px] shrink-0 items-center gap-1 rounded-md border px-2 text-[12px]', TONES[tone], className)}
    >
      <span className="truncate font-medium">{head}</span>
      {rest.length > 0 && <span className="truncate">· {rest.slice(0, 1).join(' · ')}</span>}
    </button>
  );
}

/** The Problems panel's "Notion sync" group: each problem in Landflow's words, a link to its Notion page and the buttons the viewer may press. */
export function NotionProblems({ projectId, problems, viewer, onChanged }: { projectId: string; problems: LinkProblemView[]; viewer: { canEdit: boolean; canManage: boolean }; onChanged: () => void }) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  if (!problems.length) return null;
  const act = async (problem: LinkProblemView, action: ProblemAction) => {
    setBusy(problem.id);
    setError(undefined);
    try {
      await actOnNotionProblem(projectId, problem.id, action);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div data-testid="notion-sync-group">
      <div className="px-3 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-t3">Notion sync</div>
      {problems.map((problem) => (
        <div key={problem.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1 text-[12px]" data-testid="notion-sync-problem">
          <span className="min-w-0 flex-1 basis-[200px] text-t1">{problem.detail}</span>
          {problem.notionUrl && (
            <a href={problem.notionUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-ac hover:underline max-md:min-h-11 max-md:items-center">
              Open in Notion <ExternalLink className="size-3" aria-hidden />
            </a>
          )}
          {actionsFor(problem, viewer).map((action) => (
            <Button key={action} size="sm" variant="outline" className="max-md:min-h-11" disabled={busy === problem.id} onClick={() => void act(problem, action)}>
              {PROBLEM_ACTION_LABELS[action]}
            </Button>
          ))}
        </div>
      ))}
      {error && <p className="px-3 text-[12px] text-rd">{error}</p>}
    </div>
  );
}
