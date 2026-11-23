'use client';
/**
 * The Brain workbench's Practices view (docs/practices.md): the rules agents follow, as folders. Organization first, then
 * each project, then a folder per first topic; a retired practice only under Retired at the bottom, folded. A practice with
 * a version waiting for the viewer is amber with `!`, like a page that needs a person. New practice opens the form.
 */
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, Plus, ScrollText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { practiceRef } from '@/lib/shared/brain-files';
import { PRACTICE_STRENGTH_LABELS, type PracticeView } from '@/lib/shared/practices';
import { projectLabel, useProjects } from '../../projects/use-projects';
import { Button } from '../../ui/button';
import { groupPractices, waitingVersion } from './practices-logic';
import type { PracticeList } from './practices-api';
import { PracticeForm } from './practice-form';
import { Row, type Opener } from './side-views';

function PracticeRow({ practice, depth, active, opener }: { practice: PracticeView; depth: number; active?: string; opener: Opener }) {
  const ref = practiceRef(practice.id);
  const waiting = waitingVersion(practice);
  return (
    <Row depth={depth} active={active === ref} onClick={() => opener.open(ref)} onDoubleClick={() => opener.open(ref, { pin: true })} title={practice.title}>
      <ScrollText className={cn('size-3.5 shrink-0', practice.status === 'retired' ? 'text-t3' : 'text-viz-4')} aria-hidden />
      <span className="truncate">{practice.handle}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-[10.5px] font-semibold">
        <span className={cn('rounded-full border px-1.5 py-px', practice.strength === 'required' ? 'border-acbd bg-acdim text-ac' : 'border-hair text-t3')}>{PRACTICE_STRENGTH_LABELS[practice.strength]}</span>
        {practice.status === 'draft' && waiting === undefined && <span className="text-t3">Draft</span>}
        {waiting !== undefined && (
          <span className="text-warn" title={`Version ${waiting} waits for you`}>
            !
          </span>
        )}
      </span>
    </Row>
  );
}

function FolderRow({ depth, open, onToggle, name, count }: { depth: number; open: boolean; onToggle: () => void; name: string; count?: number }) {
  return (
    <Row depth={depth} onClick={onToggle} title={name}>
      {open ? <ChevronDown className="size-3.5 shrink-0 text-t3" /> : <ChevronRight className="size-3.5 shrink-0 text-t3" />}
      {open ? <FolderOpen className="size-3.5 shrink-0 text-t3" /> : <Folder className="size-3.5 shrink-0 text-t3" />}
      <span className="truncate">{name}</span>
      {count !== undefined && <span className="ml-auto text-[11px] tabular-nums text-t3">{count}</span>}
    </Row>
  );
}

export function PracticesView({ list, active, opener }: { list: PracticeList; active?: string; opener: Opener }) {
  const { projects } = useProjects();
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [retiredOpen, setRetiredOpen] = useState(false);
  const [form, setForm] = useState(false);
  const names = useMemo(() => new Map((projects ?? []).map((p) => [p.id, projectLabel(p)])), [projects]);
  const { groups, retired } = useMemo(() => groupPractices([...(list.data?.practices ?? []), ...(list.retired ?? [])], (id) => names.get(id) ?? 'Project'), [list.data, list.retired, names]);
  const flip = (path: string) => setClosed((c) => (c.has(path) ? new Set([...c].filter((p) => p !== path)) : new Set([...c, path])));
  const waiting = list.data?.waiting ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-2.5 pb-2">
        <Button size="sm" variant="primary" className="max-md:h-9" onClick={() => setForm(true)}>
          <Plus className="size-3.5" aria-hidden />
          New practice
        </Button>
        {waiting > 0 && (
          <span className="text-[11.5px] text-warn" aria-live="polite">
            {waiting} waiting for you
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {list.error && <p className="px-3 text-[12px] text-rd">{list.error}</p>}
        {!list.data && !list.error && <div className="mx-3 h-24 rounded-lg bg-acdim animate-pulse-soft" />}
        {list.data && !groups.length && (
          <p className="px-3 text-[12px] leading-snug text-t3">No practices yet. A practice is a rule agents follow once an admin approves it. Write the first with New practice.</p>
        )}
        {groups.map((group) => (
          <div key={group.path}>
            <FolderRow depth={0} open={!closed.has(group.path)} onToggle={() => flip(group.path)} name={group.label} count={group.count} />
            {!closed.has(group.path) &&
              group.folders.map((folder) => (
                <div key={folder.path}>
                  <FolderRow depth={1} open={!closed.has(folder.path)} onToggle={() => flip(folder.path)} name={folder.name} />
                  {!closed.has(folder.path) && folder.items.map((p) => <PracticeRow key={p.id} practice={p} depth={2} active={active} opener={opener} />)}
                </div>
              ))}
          </div>
        ))}
        {list.data && (
          <div>
            <FolderRow
              depth={0}
              open={retiredOpen}
              onToggle={() => {
                if (!retiredOpen && !list.retired) list.loadRetired();
                setRetiredOpen(!retiredOpen);
              }}
              name="Retired"
              count={list.retired ? retired.length : undefined}
            />
            {retiredOpen && !list.retired && <p className="px-6 text-[12px] text-t3">Loading…</p>}
            {retiredOpen && list.retired && !retired.length && <p className="px-6 text-[12px] text-t3">Nothing is retired.</p>}
            {retiredOpen && retired.map((p) => <PracticeRow key={p.id} practice={p} depth={1} active={active} opener={opener} />)}
          </div>
        )}
      </div>
      {form && (
        <PracticeForm
          onClose={() => setForm(false)}
          onSaved={(practice) => {
            setForm(false);
            list.reload();
            opener.open(practiceRef(practice.id), { pin: true });
          }}
        />
      )}
    </div>
  );
}
