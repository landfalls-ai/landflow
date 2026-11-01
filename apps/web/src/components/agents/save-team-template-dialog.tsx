'use client';
/**
 * "Save as template" on a team page (docs/templates.md#team-templates): the team, its Landflow agents and its remote
 * members become one template, with, optionally, one of the flows that run the team. Credentials stay here: the template
 * keeps a slot for each one the agents, the remote members and the flow name.
 */
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LayoutTemplate } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { can } from '@/lib/shared/auth';
import type { TemplateDetail } from '@/lib/shared/templates';
import { useViewer } from '@/components/auth/viewer';
import { projectLabel, useProjects, writableProjects } from '@/components/projects/use-projects';
import { Button } from '../ui/button';
import { Input, Select, Textarea } from '../ui/inputs';
import { Dialog, Field } from './dialog';

const INSTANCE = '__instance__';

interface Flow {
  id: string;
  name: string;
  active: boolean;
  nodes: number;
}

export function SaveTeamTemplateDialog({ teamId, teamName, goal, onClose }: { teamId: string; teamName: string; goal?: string; onClose: () => void }) {
  const router = useRouter();
  const viewer = useViewer();
  const admin = can(viewer, 'projects:manage');
  const { projects } = useProjects();
  const targets = useMemo(() => writableProjects(projects), [projects]);
  const [name, setName] = useState(teamName);
  const [description, setDescription] = useState(goal ?? '');
  const [flows, setFlows] = useState<Flow[]>();
  const [flow, setFlow] = useState('');
  const [project, setProject] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api<{ flows: Flow[] }>(`/api/agent-teams/${encodeURIComponent(teamId)}/flows`)
      .then((r) => setFlows(r.flows))
      .catch(() => setFlows([]));
  }, [teamId]);
  useEffect(() => {
    if (project || !projects) return;
    setProject(admin ? INSTANCE : (targets.find((p) => p.type === 'personal')?.id ?? targets[0]?.id));
  }, [project, projects, targets, admin]);

  const submit = async () => {
    if (!name.trim()) return setError('Give the template a name');
    setSaving(true);
    setError(undefined);
    try {
      const { template } = await api<{ template: TemplateDetail }>(`/api/agent-teams/${encodeURIComponent(teamId)}/template`, {
        method: 'POST',
        json: { name: name.trim(), description, ...(flow && { workflowId: flow }), ...(project && { projectId: project === INSTANCE ? null : project }) },
      });
      toast.success(`Saved “${template.name}” as a template`, { action: { label: 'Open', onClick: () => router.push(`/templates/${template.id}`) } });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <Dialog
      title="Save team as template"
      subtitle="The team, its agents and, if you pick one, the flow that runs it"
      icon={<LayoutTemplate className="size-5 text-t2" />}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={() => void submit()} loading={saving}>
            Save template
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
        <Field id="team-template-name" label="Name" required>
          <Input id="team-template-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus />
        </Field>
        <Field id="team-template-description" label="Description" hint="Markdown. What the team does and who it’s for.">
          <Textarea id="team-template-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} />
        </Field>
        <Field id="team-template-flow" label="Flow" hint="A flow with a Run a Team node set to this team. Using the template creates it pointing at the new team.">
          <Select id="team-template-flow" value={flow} onChange={(e) => setFlow(e.target.value)} disabled={!flows}>
            <option value="">{flows && !flows.length ? 'No flow runs this team yet' : 'The team alone, no flow'}</option>
            {flows?.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} ({f.nodes} node{f.nodes === 1 ? '' : 's'}
                {f.active ? ', active' : ''})
              </option>
            ))}
          </Select>
        </Field>
        <Field id="team-template-project" label="Available to" hint="A project’s members see its templates; instance-wide ones show to everyone.">
          <Select id="team-template-project" value={project ?? ''} onChange={(e) => setProject(e.target.value)} disabled={!projects}>
            {admin && <option value={INSTANCE}>The whole instance</option>}
            {targets.map((p) => (
              <option key={p.id} value={p.id}>
                {projectLabel(p, viewer?.id)}
              </option>
            ))}
          </Select>
        </Field>
        <p className="rounded-[10px] border border-hair bg-wl px-3 py-2.5 text-[12px] leading-snug text-t2">
          Every Landflow agent in the team comes along with its published version (its draft while unpublished); remote members keep their A2A address. Credentials never do: each one becomes a slot that whoever uses the template picks or creates.
        </p>
        {error && <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>}
      </form>
    </Dialog>
  );
}
