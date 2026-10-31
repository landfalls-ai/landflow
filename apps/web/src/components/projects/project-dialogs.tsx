'use client';
/** Creating a team project (owners and admins) and deleting one, with where what it owns goes. */
import { useId, useState } from 'react';
import { FolderKanban, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import type { ProjectView, ResourceKind } from '@/lib/shared/projects';
import { useViewer } from '@/components/auth/viewer';
import { Dialog, Field } from '@/components/agents/dialog';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/inputs';
import { projectLabel, useProjectStore, useProjects, writableProjects } from './use-projects';

const NOUNS: Record<ResourceKind, [string, string]> = { workflow: ['workflow', 'workflows'], credential: ['credential', 'credentials'], dataTable: ['data table', 'data tables'], agent: ['agent', 'agents'], agentTeam: ['agent team', 'agent teams'] };

/** "3 workflows, 1 credential" from per-kind counts. */
export function describeCounts(counts: Partial<Record<ResourceKind, number>> | undefined): string {
  const parts = (Object.keys(NOUNS) as ResourceKind[]).flatMap((kind) => {
    const n = counts?.[kind] ?? 0;
    return n ? [`${n} ${NOUNS[kind][n === 1 ? 0 : 1]}`] : [];
  });
  return parts.join(', ');
}

export function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated?: (id: string) => void }) {
  const id = useId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      const { project } = await api<{ project: ProjectView }>('/api/projects', { method: 'POST', json: { name: name.trim(), ...(description.trim() && { description: description.trim() }) } });
      await useProjectStore.getState().refresh();
      toast.success(`Created “${project.name}”`);
      onClose();
      onCreated?.(project.id);
    } catch (e) {
      toast.error((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <Dialog
      title="New project"
      subtitle="A shared space for a team's workflows, credentials, data tables and agents"
      icon={<FolderKanban className="size-4 text-t2" />}
      width={480}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={saving} disabled={!name.trim()}>
            Create project
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void submit();
        }}
      >
        <Field id={`${id}-name`} label="Name" required>
          <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus placeholder="Data team" />
        </Field>
        <Field id={`${id}-description`} label="Description">
          <Textarea id={`${id}-description`} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={3} placeholder="What the project is for" />
        </Field>
        <p className="text-[12px] text-t3">You can add members and their roles (admin, editor or viewer) in the project’s settings.</p>
      </form>
    </Dialog>
  );
}

/** Delete a team project; when it owns anything, everything moves to another project first (one transaction). */
export function DeleteProjectDialog({ project, onClose, onDeleted }: { project: ProjectView; onClose: () => void; onDeleted?: () => void }) {
  const viewer = useViewer();
  const { projects } = useProjects();
  const owned = describeCounts(project.counts);
  const choices = writableProjects(projects).filter((p) => p.id !== project.id);
  const [target, setTarget] = useState('');
  const [deleting, setDeleting] = useState(false);

  const remove = async () => {
    setDeleting(true);
    try {
      await api(`/api/projects/${encodeURIComponent(project.id)}${target ? `?transferTo=${encodeURIComponent(target)}` : ''}`, { method: 'DELETE' });
      await useProjectStore.getState().refresh();
      toast.success(`Deleted “${project.name}”`);
      onClose();
      onDeleted?.();
    } catch (e) {
      toast.error((e as Error).message);
      setDeleting(false);
    }
  };

  return (
    <Dialog
      title={`Delete “${project.name}”?`}
      icon={<Trash2 className="size-4 text-rd" />}
      width={480}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void remove()} loading={deleting} disabled={Boolean(owned) && !target}>
            Delete project
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-[13px] text-t1">
        <p>Its members lose access to what it owns, and what is shared with it stops being shared. Nothing it owns is deleted.</p>
        {owned ? (
          <Field id="delete-project-target" label={`Move its ${owned} to`} required>
            <Select id="delete-project-target" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Choose a project…</option>
              {choices.map((p) => (
                <option key={p.id} value={p.id}>
                  {projectLabel(p, viewer?.id)}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <p className="text-t3">It owns nothing.</p>
        )}
      </div>
    </Dialog>
  );
}
