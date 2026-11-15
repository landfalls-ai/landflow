'use client';
/**
 * /goals (docs/projects-and-goals.md): the mission, then the goals. A desktop shows a tree (arrow keys open and close
 * branches, a click opens the goal in a side sheet); a phone shows one column of cards that drill into sub-goals.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronLeft, ChevronRight, Pencil, Plus, Target, X } from 'lucide-react';
import { usePhone } from '@/lib/client/use-phone';
import { type GoalLevel, type GoalNode } from '@/lib/shared/goals';
import { useViewer } from '@/components/auth/viewer';
import { can } from '@/lib/shared/auth';
import { useProjects } from '@/components/projects/use-projects';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Chip, FilterChip } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Select } from '@/components/ui/inputs';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { useDialogFocus } from '@/components/ui/use-dialog-focus';
import { cn } from '@/lib/utils';
import { GoalCard, GoalLevelChip, GoalStatusChip } from './goal-card';
import type { GoalProgress, ProgressWindow } from '@/lib/shared/goal-progress';
import { GoalProgressLine, useGoalProgress } from './goal-progress';
import { GoalDialog, type GoalDefaults } from './goal-dialog';
import { allNodes, filterTree, flattenTree, formatTarget, indexGoals, parentIds, parentTitle, type GoalFilter } from './tree';
import { useGoals } from './use-goals';

type View = 'active' | 'all';

export function GoalsView() {
  const viewer = useViewer();
  const phone = usePhone();
  const { data, error, reload } = useGoals();
  const { projects } = useProjects();
  const progress = useGoalProgress(7);
  const [view, setView] = useState<View>('active');
  const [projectId, setProjectId] = useState<string>();
  const [expanded, setExpanded] = useState<Set<string>>();
  const [openId, setOpenId] = useState<string>();
  const [drillId, setDrillId] = useState<string>();
  const [dialog, setDialog] = useState<{ goal?: GoalNode; defaults?: GoalDefaults }>();

  const isAdmin = can(viewer, 'settings:manage');
  const canCreate = Boolean(data?.canCreateCompanyGoals) || (projects ?? []).some((p) => p.role === 'admin');
  const filter: GoalFilter = { activeOnly: view === 'active', projectId };
  const tree = useMemo(() => filterTree(data?.goals ?? [], filter), [data, view, projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const index = useMemo(() => indexGoals(data?.goals ?? []), [data]);
  // The tree starts open.
  const open = useMemo(() => expanded ?? parentIds(tree), [expanded, tree]);
  const rows = useMemo(() => flattenTree(tree, open), [tree, open]);
  const opened = openId ? index.get(openId) : undefined;
  const hasAny = (data?.goals.length ?? 0) > 0;

  const projectsInUse = useMemo(() => {
    const seen = new Map<string, string>();
    for (const { node } of allNodes(data?.goals ?? [])) for (const p of node.projects) seen.set(p.id, p.name);
    return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);

  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };
  const newGoal = () => setDialog({});

  return (
    <>
      <PageHeader
        title="Goals"
        actions={canCreate && <Button variant="primary" size="sm" onClick={newGoal}><Plus className="size-3.5" /> New goal</Button>}
      />
      <PageBody>
        <p className="mb-4 text-[13px] text-t2">
          <span className="font-semibold text-t1">Company mission:</span>{' '}
          {data?.mission ? data.mission : isAdmin ? <Link href="/settings#company" className="text-ac hover:underline">Set the mission in Settings → Company</Link> : <span className="text-t3">not set yet</span>}
        </p>
        {error && <Card><EmptyState title="Goals not available" hint={error} /></Card>}
        {!error && !data && <p className="text-[13px] text-t3">Loading…</p>}
        {data && !hasAny && (
          <Card>
            <EmptyState
              icon={<Target />}
              title="No goals yet"
              hint="A goal says what a project or the company is for. Agents that work in a project read its goals."
              action={
                <div className="flex flex-wrap items-center justify-center gap-3">
                  {canCreate && <Button variant="outline" onClick={newGoal}>New goal</Button>}
                  {isAdmin && <Link href="/settings#company" className="text-[13px] text-ac hover:underline">Set the mission</Link>}
                </div>
              }
            />
          </Card>
        )}
        {data && hasAny && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Segmented label="Show" value={view} onChange={setView} options={[{ value: 'active', label: 'Active' }, { value: 'all', label: 'All' }]} />
              {projectsInUse.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 max-md:hidden">
                  <FilterChip active={!projectId} onClick={() => setProjectId(undefined)}>All projects</FilterChip>
                  {projectsInUse.map((p) => (
                    <FilterChip key={p.id} active={projectId === p.id} onClick={() => setProjectId(projectId === p.id ? undefined : p.id)}>{p.name}</FilterChip>
                  ))}
                </div>
              )}
              {projectsInUse.length > 0 && (
                <div className="hidden max-md:block max-md:w-full">
                  <Select aria-label="Project" value={projectId ?? ''} onChange={(e) => setProjectId(e.target.value || undefined)} className="max-md:h-11">
                    <option value="">All projects</option>
                    {projectsInUse.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </Select>
                </div>
              )}
            </div>
            {tree.length === 0 ? (
              <Card><EmptyState compact title="No goals match" hint="Try All, or another project." /></Card>
            ) : phone ? (
              <PhoneList progress={progress} tree={tree} index={index} drillId={drillId} onDrill={setDrillId} onOpen={setOpenId} />
            ) : (
              <GoalTree progress={progress} rows={rows} onToggle={toggle} onOpen={setOpenId} />
            )}
          </>
        )}
      </PageBody>
      {opened && (
        <GoalDetail
          goal={opened}
          index={index}
          phone={phone}
          onClose={() => setOpenId(undefined)}
          onOpen={setOpenId}
          onEdit={() => { setOpenId(undefined); setDialog({ goal: opened }); }}
          onNewSub={() => { setOpenId(undefined); setDialog({ defaults: { level: opened.level === 'company' ? 'company' : 'project', projectId: opened.projectId, parentId: opened.id } }); }}
        />
      )}
      {dialog && data && (
        <GoalDialog goal={dialog.goal} defaults={dialog.defaults} goals={data.goals} canCreateCompanyGoals={data.canCreateCompanyGoals} onClose={() => setDialog(undefined)} onSaved={() => void reload()} />
      )}
    </>
  );
}

/** The desktop tree: 40 px rows, arrow keys move, → opens, ← closes (or goes to the parent), Enter opens the goal. */
function GoalTree({ rows, progress, onToggle, onOpen }: { progress: Map<string, GoalProgress>; rows: ReturnType<typeof flattenTree>; onToggle: (id: string) => void; onOpen: (id: string) => void }) {
  const [focusId, setFocusId] = useState<string>();
  const list = useRef<HTMLDivElement>(null);
  const current = rows.some((r) => r.node.id === focusId) ? focusId : rows[0]?.node.id;
  const focusRow = (id?: string) => {
    if (!id) return;
    setFocusId(id);
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-goal="${id}"]`)?.focus());
  };
  const onKey = (e: KeyboardEvent, i: number) => {
    const row = rows[i]!;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusRow(rows[i + 1]?.node.id); break;
      case 'ArrowUp': e.preventDefault(); focusRow(rows[i - 1]?.node.id); break;
      case 'ArrowRight':
        e.preventDefault();
        if (row.hasChildren && !row.expanded) onToggle(row.node.id);
        else if (row.expanded) focusRow(rows[i + 1]?.node.id);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (row.expanded) onToggle(row.node.id);
        else focusRow(row.parentId);
        break;
      case 'Home': e.preventDefault(); focusRow(rows[0]?.node.id); break;
      case 'End': e.preventDefault(); focusRow(rows[rows.length - 1]?.node.id); break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        onOpen(row.node.id);
        break;
    }
  };
  return (
    <div ref={list} role="tree" aria-label="Goals" className="overflow-hidden rounded-2xl border border-hair bg-sf">
      {rows.map((row, i) => {
        const { node } = row;
        const target = formatTarget(node.targetDate);
        return (
          <div
            key={node.id}
            role="treeitem"
            aria-level={row.depth}
            aria-expanded={row.hasChildren ? row.expanded : undefined}
            data-goal={node.id}
            tabIndex={node.id === current ? 0 : -1}
            onKeyDown={(e) => onKey(e, i)}
            onFocus={() => setFocusId(node.id)}
            onClick={() => onOpen(node.id)}
            className="flex min-h-10 cursor-pointer items-center gap-2 border-b border-hair pr-3 text-[13px] last:border-b-0 hover:bg-acdim focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ac"
            style={{ paddingLeft: 8 + (row.depth - 1) * 20 }}
          >
            {row.hasChildren ? (
              <button type="button" tabIndex={-1} aria-label={row.expanded ? 'Collapse' : 'Expand'} onClick={(e) => { e.stopPropagation(); onToggle(node.id); }} className="grid size-6 shrink-0 place-items-center rounded-full text-t3 hover:bg-hair hover:text-t1">
                {row.expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              </button>
            ) : (
              <span className="size-6 shrink-0" aria-hidden />
            )}
            <span className="min-w-0 flex-1 py-1">
              <span className="block truncate font-semibold text-t1">{node.title}</span>
              {progress.get(node.id) && <GoalProgressLine progress={progress.get(node.id)!} className="[&>span:last-child]:truncate" />}
            </span>
            <GoalLevelChip level={node.level} />
            <GoalStatusChip status={node.status} />
            <span className="w-28 shrink-0 truncate text-t2" title={node.ownerName}>{node.ownerName ?? ''}</span>
            <span className="w-24 shrink-0 text-t3">{target ?? ''}</span>
            <span className="flex max-w-[220px] shrink-0 items-center gap-1 overflow-hidden">
              {node.projects.slice(0, 2).map((p) => (
                <Chip key={p.id} className="max-w-[100px] truncate !px-2 text-[11px]">{p.name}</Chip>
              ))}
              {node.projects.length > 2 && <span className="text-[11px] text-t3">+{node.projects.length - 2}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** The phone's list: one column of cards; a goal's sub-goals open under a back row. */
function PhoneList({ progress, tree, index, drillId, onDrill, onOpen }: { progress: Map<string, GoalProgress>; tree: GoalNode[]; index: Map<string, GoalNode>; drillId?: string; onDrill: (id: string | undefined) => void; onOpen: (id: string) => void }) {
  const drilled = drillId ? findIn(tree, drillId) : undefined;
  const list = drilled ? drilled.children : tree;
  return (
    <div className="space-y-2.5">
      {drilled && (
        <>
          <button type="button" onClick={() => onDrill(drilled.parentId && findIn(tree, drilled.parentId) ? drilled.parentId : undefined)} className="flex min-h-11 w-full items-center gap-1.5 text-left text-[13px] font-semibold text-ac">
            <ChevronLeft className="size-4" aria-hidden /> {drilled.parentId ? parentTitle(index, drilled) ?? 'Back' : 'All goals'}
          </button>
          <GoalCard goal={{ ...drilled, children: [] }} progress={progress.get(drilled.id)} parent={parentTitle(index, drilled)} onOpen={() => onOpen(drilled.id)} />
          <p className="px-1 pt-1 text-[12px] font-semibold text-t3">Sub-goals</p>
        </>
      )}
      {list.map((g) => (
        <GoalCard key={g.id} goal={g} progress={progress.get(g.id)} parent={drilled ? undefined : parentTitle(index, g)} onOpen={() => onOpen(g.id)} onDrill={() => onDrill(g.id)} />
      ))}
    </div>
  );
}

function findIn(nodes: GoalNode[], id: string): GoalNode | undefined {
  return allNodes(nodes).find((e) => e.node.id === id)?.node;
}

/** A goal in full: why, projects, initiatives, sub-goals and Edit. A panel on the right of a desktop, a sheet on a phone. */
function GoalDetail({ goal, index, phone, onClose, onOpen, onEdit, onNewSub }: { goal: GoalNode; index: Map<string, GoalNode>; phone: boolean; onClose: () => void; onOpen: (id: string) => void; onEdit: () => void; onNewSub: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useDialogFocus(panel, !phone, { onEscape: onClose });
  const parent = parentTitle(index, goal);
  const target = formatTarget(goal.targetDate);
  const [win, setWin] = useState<ProgressWindow>(7);
  const progress = useGoalProgress(win).get(goal.id);
  const body = (
    <div className="space-y-4 text-[13px]">
      <div className="flex flex-wrap items-center gap-1.5">
        <GoalStatusChip status={goal.status} />
        <GoalLevelChip level={goal.level as GoalLevel} />
        {target && <span className="text-t3">by {target}</span>}
      </div>
      {parent && <p className="text-t3">Under: {parent}</p>}
      {goal.ownerName && <p className="text-t2">Owner: {goal.ownerName}</p>}
      {progress && (
        <div className="space-y-1.5">
          <Segmented label="Window" value={String(win) as '7' | '30'} onChange={(v) => setWin(Number(v) as ProgressWindow)} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }]} />
          <GoalProgressLine progress={progress} />
        </div>
      )}
      <Section title="Why it matters">{goal.why ? <p className="whitespace-pre-wrap text-t2">{goal.why}</p> : <p className="text-t3">Nothing written yet.</p>}</Section>
      <Section title="Projects">
        {goal.projects.length ? (
          <div className="flex flex-wrap gap-1.5">
            {goal.projects.map((p) => (
              <Link key={p.id} href={`/projects/${p.id}`} className="inline-flex min-h-8 items-center rounded-full border border-hair px-3 text-t1 hover:border-ac max-md:min-h-11">{p.name}</Link>
            ))}
          </div>
        ) : (
          <p className="text-t3">No project serves it yet.</p>
        )}
      </Section>
      {goal.initiatives.length > 0 && (
        <Section title="Initiatives">
          <ul className="space-y-1">
            {goal.initiatives.map((i) => (
              <li key={i.id} className="text-t2">{i.name}</li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="Sub-goals">
        {goal.children.length ? (
          <div className="overflow-hidden rounded-xl border border-hair">
            {goal.children.map((c) => (
              <button key={c.id} type="button" onClick={() => onOpen(c.id)} className="flex min-h-10 w-full items-center gap-2 border-b border-hair px-3 py-1.5 text-left last:border-b-0 hover:bg-acdim max-md:min-h-11">
                <span className="min-w-0 flex-1 truncate font-semibold text-t1">{c.title}</span>
                <GoalStatusChip status={c.status} />
              </button>
            ))}
          </div>
        ) : (
          <p className="text-t3">None.</p>
        )}
      </Section>
    </div>
  );
  const actions = goal.canEdit && (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={onNewSub} className="max-md:min-h-11"><Plus className="size-3.5" /> Sub-goal</Button>
      <Button variant="primary" size="sm" onClick={onEdit} className="max-md:min-h-11"><Pencil className="size-3.5" /> Edit</Button>
    </div>
  );
  if (phone) return <Sheet open onClose={onClose} title={goal.title} footer={actions || undefined}>{body}</Sheet>;
  return (
    <div className="fixed inset-0 z-[55]">
      <div className="absolute inset-0 bg-overlay animate-in" onClick={onClose} aria-hidden />
      <div ref={panel} role="dialog" aria-modal="true" aria-label={goal.title} className={cn('absolute inset-y-0 right-0 flex w-[440px] max-w-full flex-col border-l border-hair bg-sf shadow-pop')}>
        <div className="flex shrink-0 items-start gap-2 border-b border-hair px-5 py-3.5">
          <h2 className="min-w-0 flex-1 text-[15px] font-semibold leading-snug text-t1">{goal.title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-7 shrink-0 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1"><X className="size-4" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{body}</div>
        {actions && <div className="flex shrink-0 justify-end border-t border-hair px-5 py-3">{actions}</div>}
      </div>
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div>
    <div className="mb-1 text-[12px] font-semibold text-t2">{title}</div>
    {children}
  </div>
);
