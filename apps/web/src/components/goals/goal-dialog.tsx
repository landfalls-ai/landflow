'use client';
/**
 * Make or change a goal (docs/projects-and-goals.md): title, why, level, status, owner, target date, parent, and for a
 * company goal the projects that serve it. API errors show in the dialog. Delete sits under ⋯ and shows the 409 text when
 * the goal has sub-goals. A dialog on a desktop, a full-height sheet on a phone.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { MoreHorizontal, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { usePhone } from '@/lib/client/use-phone';
import { GOAL_LEVEL_LABELS, GOAL_LEVELS, GOAL_LIMITS, GOAL_STATUS_LABELS, GOAL_STATUSES, type GoalLevel, type GoalNode, type GoalStatus, type GoalView } from '@/lib/shared/goals';
import { useViewer } from '@/components/auth/viewer';
import { projectLabel, useProjects } from '@/components/projects/use-projects';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, FieldLabel, Input, Select, Textarea } from '@/components/ui/inputs';
import { MenuItem, Popover } from '@/components/ui/popover';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { confirmAction } from '@/components/ui/confirm';
import { GoalPicker } from './goal-picker';
import { allNodes, allowedParents, indexGoals } from './tree';
import { projectGoalIds, putProjectGoals, usePeople } from './use-goals';

export interface GoalDefaults {
  level?: GoalLevel;
  projectId?: string;
  parentId?: string;
}

export function GoalDialog({
  goal,
  defaults,
  goals,
  canCreateCompanyGoals,
  onClose,
  onSaved,
}: {
  /** Set to edit it; unset to make a new goal. */
  goal?: GoalView;
  defaults?: GoalDefaults;
  /** The tree, for the parent choice. */
  goals: GoalNode[];
  canCreateCompanyGoals: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const phone = usePhone();
  const viewer = useViewer();
  const { projects } = useProjects();
  const adminProjects = useMemo(() => (projects ?? []).filter((p) => p.role === 'admin' && (p.type === 'team' || p.ownerId === viewer?.id)), [projects, viewer?.id]);
  const [title, setTitle] = useState(goal?.title ?? '');
  const [why, setWhy] = useState(goal?.why ?? '');
  const [level, setLevel] = useState<GoalLevel>(goal?.level ?? defaults?.level ?? (canCreateCompanyGoals ? 'company' : 'project'));
  const [status, setStatus] = useState<GoalStatus>(goal?.status ?? 'planned');
  const [projectId, setProjectId] = useState(goal?.projectId ?? defaults?.projectId ?? '');
  const [ownerId, setOwnerId] = useState(goal?.ownerId ?? '');
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? '');
  const [parentId, setParentId] = useState(goal?.parentId ?? defaults?.parentId ?? '');
  const initialServed = useMemo(() => new Set((goal?.projects ?? []).map((p) => p.id)), [goal]);
  const [served, setServed] = useState<Set<string>>(initialServed);
  const [savedId, setSavedId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const people = usePeople(level === 'project' ? projectId || undefined : undefined);

  const parents = useMemo(() => allowedParents(goals, level, goal?.id), [goals, level, goal?.id]);
  const notParents = useMemo(() => {
    const ok = new Set(parents.map((p) => p.id));
    return new Set(allNodes(goals).filter((e) => !ok.has(e.node.id)).map((e) => e.node.id));
  }, [goals, parents]);
  const index = useMemo(() => indexGoals(goals), [goals]);
  const levels = GOAL_LEVELS.filter((l) => (l === 'company' ? canCreateCompanyGoals || goal?.level === 'company' : adminProjects.length > 0 || goal?.level === 'project'));
  const projectChoices = goal?.projectId && !adminProjects.some((p) => p.id === goal.projectId) ? [...adminProjects, { id: goal.projectId, name: goal.projects.find((p) => p.id === goal.projectId)?.name ?? goal.projectId }] : adminProjects;
  const lockLevel = Boolean(goal || savedId);

  const save = async () => {
    setError(undefined);
    if (!title.trim()) return setError('Give the goal a title.');
    if (level === 'project' && !projectId) return setError('Pick the project this goal belongs to.');
    setBusy(true);
    try {
      const body = {
        title: title.trim(),
        why: why.trim() || (goal ? null : undefined),
        status,
        ownerId: ownerId || (goal ? null : undefined),
        targetDate: targetDate || (goal ? null : undefined),
        parentId: parentId || (goal ? null : undefined),
      };
      let id = goal?.id ?? savedId;
      if (id) await api(`/api/goals/${id}`, { method: 'PATCH', json: body });
      else {
        // Create is one request: the ticked projects go with it, so a refused link makes no goal.
        const created = await api<{ goal: { id: string } }>('/api/goals', { method: 'POST', json: createBody(body, level, projectId, served) });
        id = created.goal.id;
        setSavedId(id);
      }
      if (level === 'company' && (goal || savedId)) {
        try {
          await syncServed(id, initialServed, served);
        } catch (e) {
          // The goal is saved; show what failed and refresh what is behind the dialog.
          onSaved();
          throw e;
        }
      }
      toast.success(goal ? 'Goal saved' : 'Goal created');
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!goal || !(await confirmAction(`Delete the goal "${goal.title}"?`, { action: 'Delete', danger: true }))) return;
    setBusy(true);
    setError(undefined);
    try {
      await api(`/api/goals/${goal.id}`, { method: 'DELETE' });
      toast.success('Goal deleted');
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const footer = (
    <>
      {goal?.canEdit && (
        <div className="mr-auto">
          <Popover
            trigger={({ toggle }) => (
              <Button variant="ghost" size="icon" onClick={toggle} aria-label="More" className="max-md:size-11">
                <MoreHorizontal className="size-4" />
              </Button>
            )}
          >
            {(close) => (
              <MenuItem
                onClick={() => {
                  close();
                  void remove();
                }}
              >
                <Trash2 /> Delete goal
              </MenuItem>
            )}
          </Popover>
        </div>
      )}
      <Button variant="ghost" onClick={onClose} className="max-md:min-h-11">
        Cancel
      </Button>
      <Button variant="primary" onClick={() => void save()} loading={busy} className="max-md:min-h-11">
        {goal ? 'Save' : 'Create goal'}
      </Button>
    </>
  );

  const body = (
    <div className="space-y-4">
      <div>
        <FieldLabel>Title</FieldLabel>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={GOAL_LIMITS.title} placeholder="Halve month-end close time" autoFocus={!phone} className="max-md:h-11" />
      </div>
      <div>
        <FieldLabel>Why it matters</FieldLabel>
        <Textarea value={why} onChange={(e) => setWhy(e.target.value)} maxLength={GOAL_LIMITS.why} rows={3} className="w-full" />
      </div>
      <div>
        <FieldLabel>Level</FieldLabel>
        {lockLevel ? <p className="text-[13px] text-t1">{GOAL_LEVEL_LABELS[level]}</p> : <Segmented label="Level" value={level} onChange={(l) => { setLevel(l); setParentId(''); setOwnerId(''); }} options={levels.map((l) => ({ value: l, label: GOAL_LEVEL_LABELS[l] }))} />}
        {lockLevel && <p className="mt-1 text-[12px] text-t3">A goal keeps its level.</p>}
      </div>
      {level === 'project' && (
        <div>
          <FieldLabel>Project</FieldLabel>
          <Select aria-label="Project" value={projectId} disabled={Boolean(goal)} onChange={(e) => { setProjectId(e.target.value); setOwnerId(''); }} className="max-md:h-11">
            <option value="">Choose a project…</option>
            {projectChoices.map((p) => (
              <option key={p.id} value={p.id}>
                {'type' in p ? projectLabel(p, viewer?.id) : p.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        <div>
          <FieldLabel>Status</FieldLabel>
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as GoalStatus)} className="max-md:h-11">
            {GOAL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {GOAL_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <FieldLabel>Target date</FieldLabel>
          <Input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} className="max-md:h-11" aria-label="Target date" />
        </div>
      </div>
      <div>
        <FieldLabel>Owner</FieldLabel>
        <Select aria-label="Owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className="max-md:h-11">
          <option value="">No owner</option>
          {goal?.ownerId && !people.some((p) => p.id === goal.ownerId) && <option value={goal.ownerId}>{goal.ownerName ?? goal.ownerId}</option>}
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.id === viewer?.id ? ' (you)' : ''}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <FieldLabel>Under</FieldLabel>
        <GoalPicker ariaLabel="Parent goal" value={parentId || undefined} onChange={(id) => setParentId(id ?? '')} level={level} allowNone noneLabel="Nothing: a top goal" projectId={level === 'project' ? projectId || undefined : undefined} exclude={notParents} goals={goals} />
        {parentId && !index.has(parentId) && <p className="mt-1 text-[12px] text-t3">The parent is not visible to you.</p>}
      </div>
      {level === 'company' && adminProjects.length > 0 && (
        <div>
          <FieldLabel>Projects that serve it</FieldLabel>
          <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-[10px] border border-hair p-1.5">
            {adminProjects.map((p) => (
              <Checkbox
                key={p.id}
                label={projectLabel(p, viewer?.id)}
                checked={served.has(p.id)}
                onChange={(on) =>
                  setServed((prev) => {
                    const next = new Set(prev);
                    if (on) next.add(p.id);
                    else next.delete(p.id);
                    return next;
                  })
                }
              />
            ))}
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2 text-[13px] text-rd">
          {error}
        </p>
      )}
    </div>
  );
  return <GoalFrame phone={phone} title={goal ? 'Edit goal' : 'New goal'} onClose={onClose} footer={footer}>{body}</GoalFrame>;
}

/** A dialog on a desktop; a full-height sheet on a phone. */
function GoalFrame({ phone, title, onClose, footer, children }: { phone: boolean; title: string; onClose: () => void; footer: ReactNode; children: ReactNode }) {
  if (phone)
    return (
      <Sheet open onClose={onClose} title={title} footer={<div className="flex items-center gap-2">{footer}</div>} className="h-[100dvh] max-h-[100dvh] rounded-none border-0">
        {children}
      </Sheet>
    );
  return (
    <Dialog title={title} onClose={onClose} footer={footer} width={560}>
      {children}
    </Dialog>
  );
}

/** The body of POST /api/goals: a company goal carries the projects that serve it. */
export function createBody(body: Record<string, unknown>, level: GoalLevel, projectId: string, served: ReadonlySet<string>) {
  return { ...body, level, projectId: level === 'project' ? projectId : undefined, projectIds: level === 'company' && served.size ? [...served] : undefined };
}

/** Link or unlink the projects that serve a company goal: each project keeps its other goals, the goal goes last. */
async function syncServed(goalId: string, before: Set<string>, after: Set<string>) {
  for (const projectId of new Set([...before, ...after])) {
    if (before.has(projectId) === after.has(projectId)) continue;
    const ids = (await projectGoalIds(projectId)).filter((id) => id !== goalId);
    await putProjectGoals(projectId, after.has(projectId) ? [...ids, goalId] : ids);
  }
}
