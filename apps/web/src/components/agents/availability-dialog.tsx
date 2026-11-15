'use client';
/**
 * "Make available…": the projects that may use this agent, as checkboxes, and "All projects". Home admins change it (PUT
 * /api/agents/:id/shares); others read it. On a phone the shared dialog is a bottom sheet (docs/mobile.md).
 */
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Share2 } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/inputs';
import { Dialog } from './dialog';
import { availabilityBody, sharedIds, ALL_PROJECTS_LABEL, type AvailabilityAnswer, type ProjectRef } from './project-names';

/** The part of `GET /api/agents/:id/shares` the dialog reads. */
interface SharesAnswer {
  availability: AvailabilityAnswer;
  shares: Array<{ projectId: string }>;
}

/** The checkboxes alone (the dialog around them needs a browser). */
export function AvailabilityForm({
  home,
  projects,
  selected,
  all,
  canEdit,
  hidden = 0,
  onToggle,
  onAll,
}: {
  home: ProjectRef;
  projects: readonly ProjectRef[];
  selected: readonly string[];
  all: boolean;
  canEdit: boolean;
  /** Shares to projects the person can't see: kept when saving. */
  hidden?: number;
  onToggle: (id: string, on: boolean) => void;
  onAll: (on: boolean) => void;
}) {
  const others = projects.filter((p) => p.id !== home.id);
  return (
    <div className="space-y-1">
      <p className="mb-2 text-[12px] leading-snug text-t3">
        {canEdit ? 'People in these projects can use the agent in their chats and flows. It stays in its home project, and only its editors change it.' : 'Only admins of the agent’s project change this.'}
      </p>
      <Checkbox checked onChange={() => {}} disabled label={<span>{home.name} <span className="text-t3">· home</span></span>} />
      <Checkbox checked={all} disabled={!canEdit} onChange={onAll} label={ALL_PROJECTS_LABEL} />
      <fieldset className="space-y-1 border-t border-hair pt-2" aria-label="Projects" disabled={!canEdit || all}>
        {others.map((p) => (
          <Checkbox key={p.id} checked={all || selected.includes(p.id)} disabled={!canEdit || all} onChange={(on) => onToggle(p.id, on)} label={p.name} />
        ))}
        {!others.length && <p className="text-[12px] text-t3">There are no other projects yet.</p>}
      </fieldset>
      {hidden > 0 && !all && <p className="pt-1 text-[12px] text-t3">Also shared with {hidden} project{hidden === 1 ? '' : 's'} you aren’t in. Saving keeps {hidden === 1 ? 'it' : 'them'}.</p>}
    </div>
  );
}

export function AvailabilityDialog({ agentId, agentName, canEdit = true, onClose, onSaved }: { agentId: string; agentName: string; /** Home admins only; others read. */ canEdit?: boolean; onClose: () => void; onSaved?: (availability: AvailabilityAnswer) => void }) {
  const [answer, setAnswer] = useState<SharesAnswer>();
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [all, setAll] = useState(false);
  const [failed, setFailed] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([api<SharesAnswer>(`/api/agents/${agentId}/shares`), api<{ projects: ProjectRef[] }>('/api/projects')])
      .then(([shares, list]) => {
        if (!live) return;
        setAnswer(shares);
        setProjects(list.projects.map((p) => ({ id: p.id, name: p.name })));
        setSelected(sharedIds(shares.shares, shares.availability.home.id));
        setAll(shares.availability.all);
      })
      .catch((e: Error) => live && setFailed(e.message));
    return () => {
      live = false;
    };
  }, [agentId]);

  const home = answer?.availability.home;
  const visible = useMemo(() => new Set(projects.map((p) => p.id)), [projects]);
  const hidden = selected.filter((id) => !visible.has(id)).length;
  // The server answers 403 to anyone but the home project's admins, whatever the screen shows.
  const save = async () => {
    if (!home) return;
    setSaving(true);
    try {
      const next = await api<SharesAnswer>(`/api/agents/${agentId}/shares`, { method: 'PUT', json: availabilityBody(selected, all, home.id) });
      toast.success(all ? 'Available in all projects' : 'Availability saved');
      onSaved?.(next.availability);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      title="Make available"
      subtitle={agentName}
      icon={<Share2 className="size-4 text-t2" />}
      onClose={onClose}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {canEdit ? 'Cancel' : 'Close'}
          </Button>
          {canEdit && (
            <Button size="sm" variant="primary" loading={saving} disabled={!home} onClick={() => void save()}>
              Save
            </Button>
          )}
        </>
      }
    >
      {failed && <p role="alert" className="text-[13px] text-rd">Couldn’t load where this agent is available: {failed}</p>}
      {!failed && !answer && <p className="text-[13px] text-t3">Loading…</p>}
      {home && (
        <AvailabilityForm
          home={home}
          projects={projects}
          selected={selected}
          all={all}
          canEdit={canEdit}
          hidden={hidden}
          onToggle={(id, on) => setSelected((list) => (on ? [...list, id] : list.filter((x) => x !== id)))}
          onAll={setAll}
        />
      )}
    </Dialog>
  );
}
