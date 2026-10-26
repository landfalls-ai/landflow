'use client';
/**
 * "Edit" on a saved template (PATCH /api/templates/:id): its name, description, categories, setup steps and project,
 * and optionally its workflow, replaced with a saved workflow's (credentials become slots, pinned data is left out).
 * Editors of its project change it; owners and admins the instance-wide ones.
 */
import { useEffect, useMemo, useState } from 'react';
import { Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { can } from '@/lib/shared/auth';
import { TEMPLATE_CATEGORIES, type TemplateCategory, type TemplateDetail, type UpdateTemplateRequest } from '@/lib/shared/templates';
import type { WorkflowSummary } from '@/lib/shared/types';
import { cn } from '@/lib/utils';
import { Dialog, Field } from '@/components/agents/dialog';
import { useViewer } from '@/components/auth/viewer';
import { projectLabel, useProjects, writableProjects } from '@/components/projects/use-projects';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/inputs';

const INSTANCE = '__instance__';

export function EditTemplateDialog({ template, onClose, onSaved }: { template: TemplateDetail; onClose: () => void; onSaved: (template: TemplateDetail) => void }) {
  const viewer = useViewer();
  const { projects } = useProjects();
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description);
  const [categories, setCategories] = useState<TemplateCategory[]>(template.categories as TemplateCategory[]);
  const [setup, setSetup] = useState(template.setup.join('\n'));
  const [project, setProject] = useState(template.projectId ?? INSTANCE);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>();
  const [workflowId, setWorkflowId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const admin = can(viewer, 'projects:manage');
  const targets = useMemo(() => writableProjects(projects), [projects]);

  useEffect(() => {
    api<{ workflows: WorkflowSummary[] }>('/api/workflows')
      .then((r) => setWorkflows([...r.workflows].sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => setWorkflows([]));
  }, []);

  const toggle = (id: TemplateCategory) => setCategories((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const steps = setup.split('\n').map((s) => s.trim()).filter(Boolean);

  const submit = async () => {
    if (!name.trim()) return setError('Give the template a name');
    const patch: UpdateTemplateRequest = {};
    if (name.trim() !== template.name) patch.name = name.trim();
    if (description !== template.description) patch.description = description;
    if (JSON.stringify(categories) !== JSON.stringify(template.categories)) patch.categories = categories;
    if (JSON.stringify(steps) !== JSON.stringify(template.setup)) patch.setup = steps;
    if (workflowId) patch.workflowId = workflowId;
    if ((project === INSTANCE ? undefined : project) !== template.projectId) patch.projectId = project === INSTANCE ? null : project;
    if (!Object.keys(patch).length) return onClose();
    setSaving(true);
    setError(undefined);
    try {
      const { template: saved } = await api<{ template: TemplateDetail }>(`/api/templates/${encodeURIComponent(template.id)}`, { method: 'PATCH', json: patch });
      toast.success(`Saved “${saved.name}”`);
      onSaved(saved);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <Dialog
      title="Edit template"
      subtitle={template.name}
      icon={<Pencil className="size-5 text-t2" />}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={() => void submit()} loading={saving}>
            Save changes
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field id="edit-template-name" label="Name" required>
          <Input id="edit-template-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus />
        </Field>
        <Field id="edit-template-description" label="Description" hint="Markdown. What it does and who it’s for.">
          <Textarea id="edit-template-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} />
        </Field>
        <Field label="Categories">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Categories">
            {TEMPLATE_CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={categories.includes(c.id)}
                onClick={() => toggle(c.id)}
                className={cn('rounded-full border px-2.5 py-0.5 text-[12px] transition-colors', categories.includes(c.id) ? 'border-ac bg-acdim text-ac' : 'border-hair text-t2 hover:border-ac')}
              >
                {c.name}
              </button>
            ))}
          </div>
        </Field>
        <Field id="edit-template-setup" label="Setup steps" hint="One step per line, Markdown: what to fill in before the first run.">
          <Textarea id="edit-template-setup" value={setup} onChange={(e) => setSetup(e.target.value)} rows={4} />
        </Field>
        <Field id="edit-template-project" label="Available to" hint="A project’s members see its templates; instance-wide ones show to everyone.">
          <Select id="edit-template-project" value={project} onChange={(e) => setProject(e.target.value)}>
            {(admin || !template.projectId) && <option value={INSTANCE} disabled={!admin}>The whole instance</option>}
            {template.projectId && !targets.some((p) => p.id === template.projectId) && <option value={template.projectId}>{template.projectName ?? 'Its project'}</option>}
            {targets.map((p) => (
              <option key={p.id} value={p.id}>
                {projectLabel(p, viewer?.id)}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="edit-template-workflow" label="Replace the workflow" hint="With a saved workflow’s nodes and connections (its credentials become slots; pinned data is left out).">
          <Select id="edit-template-workflow" value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} disabled={!workflows}>
            <option value="">Keep the template’s workflow</option>
            {workflows?.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>
        {error && <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>}
      </form>
    </Dialog>
  );
}
