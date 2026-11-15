'use client';
/**
 * The brief at the top of a project's Overview (docs/projects-and-goals.md): status, target date, lead and decision
 * owner; the brief, constraints, done when and words we use (each folds to 3 lines on a phone, up to 6 on a desktop);
 * then the goals the project serves, in order, which its admins reorder, link and add to.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, Pencil, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { usePhone } from '@/lib/client/use-phone';
import { PROJECT_STATUS_LABELS, type ProjectBriefView } from '@/lib/shared/goals';
import { GoalLevelChip, GoalStatusChip } from '@/components/goals/goal-card';
import { GoalDialog } from '@/components/goals/goal-dialog';
import { GoalPicker } from '@/components/goals/goal-picker';
import { briefFold, formatTarget } from '@/components/goals/tree';
import { putProjectGoals, useGoals } from '@/components/goals/use-goals';
import { Card } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { BriefDialog } from './brief-dialog';

const DESKTOP_LINES = 6;
const PHONE_LINES = 3;

/** True when a brief has nothing in it: no text, no status or dates, no goals. */
export const briefIsEmpty = (b?: ProjectBriefView) => !b || (!b.brief && !b.constraints && !b.doneWhen && !b.glossary && !b.status && !b.targetDate && !b.leadId && !b.decisionOwnerId && b.goals.length === 0);

export function ProjectBriefCard({ projectId, brief, onChanged }: { projectId: string; brief?: ProjectBriefView; onChanged: () => void }) {
  const phone = usePhone();
  const [editing, setEditing] = useState(false);
  const canEdit = Boolean(brief?.canEdit);
  const [newGoal, setNewGoal] = useState(false);
  const [linking, setLinking] = useState(false);
  const { data: goalData, reload: reloadGoals } = useGoals(canEdit);

  if (briefIsEmpty(brief) && !editing && !newGoal) {
    if (!canEdit) return null;
    return (
      <Card className="flex items-center gap-3 max-md:flex-col max-md:items-stretch">
        <p className="min-w-0 flex-1 text-[13px] text-t2">Give this project a brief and goals: agents that work here will read them</p>
        <Button variant="outline" size="sm" onClick={() => setEditing(true)} className="max-md:min-h-11">Edit brief</Button>
      </Card>
    );
  }

  const ids = (brief?.goals ?? []).map((g) => g.id);
  const save = async (next: string[]) => {
    try {
      await putProjectGoals(projectId, next);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const move = (i: number, by: -1 | 1) => {
    const next = [...ids];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    void save(next);
  };
  const target = formatTarget(brief?.targetDate);
  const lines = phone ? PHONE_LINES : DESKTOP_LINES;
  const sections: Array<[string, string | undefined]> = [
    ['Brief', brief?.brief],
    ['Constraints', brief?.constraints],
    ['Done when', brief?.doneWhen],
    ['Words we use', brief?.glossary],
  ];

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-t3">
        {brief?.status && <Badge tone={brief.status === 'active' ? 'accent' : brief.status === 'done' ? 'success' : 'neutral'}>{PROJECT_STATUS_LABELS[brief.status]}</Badge>}
        {target && <span>Target {target}</span>}
        {brief?.leadName && <span>Lead: <span className="text-t2">{brief.leadName}</span></span>}
        {brief?.decisionOwnerName && <span>Decision owner: <span className="text-t2">{brief.decisionOwnerName}</span></span>}
        {canEdit && (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)} className="ml-auto max-md:min-h-11">
            <Pencil className="size-3.5" /> Edit brief
          </Button>
        )}
      </div>
      {sections.map(([label, text]) => text && <BriefSection key={label} label={label} text={text} lines={lines} phone={phone} />)}
      <div>
        <div className="mb-1.5 text-[12px] font-semibold text-t2">Goals it serves</div>
        {ids.length === 0 ? (
          <p className="text-[13px] text-t3">No goals yet.</p>
        ) : (
          <ol className="overflow-hidden rounded-xl border border-hair">
            {brief!.goals.map((g, i) => (
              <li key={g.id} className="flex items-center gap-2 border-b border-hair px-3 py-1.5 last:border-b-0 max-md:min-h-11 max-md:flex-wrap">
                <span className="w-4 shrink-0 text-[12px] tabular-nums text-t3">{i + 1}</span>
                <Link href="/goals" className="min-w-0 flex-1 truncate text-[13px] font-semibold text-t1 hover:text-ac max-md:basis-[calc(100%-1.5rem)] max-md:py-2">{g.title}</Link>
                <GoalLevelChip level={g.level} />
                <GoalStatusChip status={g.status} />
                {canEdit && (
                  <span className="flex shrink-0 items-center max-md:ml-auto">
                    <Button variant="ghost" size="icon-sm" aria-label={`Move ${g.title} up`} disabled={i === 0} onClick={() => move(i, -1)} className="max-md:size-11"><ArrowUp className="size-3.5" /></Button>
                    <Button variant="ghost" size="icon-sm" aria-label={`Move ${g.title} down`} disabled={i === ids.length - 1} onClick={() => move(i, 1)} className="max-md:size-11"><ArrowDown className="size-3.5" /></Button>
                    <Button variant="ghost" size="icon-sm" aria-label={`Unlink ${g.title}`} onClick={() => void save(ids.filter((id) => id !== g.id))} className="max-md:size-11"><X className="size-3.5" /></Button>
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
        {canEdit && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {linking ? (
              <div className="w-full max-w-sm">
                <GoalPicker
                  ariaLabel="Link a goal"
                  projectId={projectId}
                  goals={goalData?.goals}
                  exclude={new Set(ids)}
                  allowNone
                  noneLabel="Choose a goal to link…"
                  onChange={(id) => {
                    setLinking(false);
                    if (id) void save([...ids, id]);
                  }}
                />
              </div>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setLinking(true)} className="max-md:min-h-11">Link a goal</Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setNewGoal(true)} className="max-md:min-h-11"><Plus className="size-3.5" /> New project goal</Button>
          </div>
        )}
      </div>
      {editing && <BriefDialog projectId={projectId} brief={brief} onClose={() => setEditing(false)} onSaved={onChanged} />}
      {newGoal && goalData && (
        <GoalDialog
          defaults={{ level: 'project', projectId }}
          goals={goalData.goals}
          canCreateCompanyGoals={goalData.canCreateCompanyGoals}
          onClose={() => setNewGoal(false)}
          onSaved={() => {
            void reloadGoals();
            onChanged();
          }}
        />
      )}
    </Card>
  );
}

/** One brief field: clamped to its first lines, with More whenever the text is really cut (measured, so wrapped paragraphs count). */
function BriefSection({ label, text, lines, phone }: { label: string; text: string; lines: number; phone: boolean }) {
  const [more, setMore] = useState(false);
  const [clamped, setClamped] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  const fold = briefFold(text, lines);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || more) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, more, phone]);
  const long = fold.folded || clamped || more;
  return (
    <div>
      <div className="mb-0.5 text-[12px] font-semibold text-t2">{label}</div>
      <p ref={ref} className={`whitespace-pre-wrap text-[13px] leading-relaxed text-t1 ${!more ? (phone ? 'line-clamp-3' : 'line-clamp-6') : ''}`}>{more ? text : fold.text}</p>
      {long && (
        <button type="button" onClick={() => setMore(!more)} aria-expanded={more} className="mt-0.5 text-[12px] font-semibold text-ac hover:underline max-md:min-h-11">
          {more ? 'Less' : 'More'}
        </button>
      )}
    </div>
  );
}
