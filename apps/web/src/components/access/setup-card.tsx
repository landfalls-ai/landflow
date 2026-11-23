'use client';
/**
 * The admin's one click (docs/access-requests.md#setting-up): pick the project the two flows live in and, optionally, the Anthropic
 * key the chat uses, then "Set up access requests". After it, the card says where the flows are.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { accessApi } from '@/lib/client/access';
import type { AccessSetup } from '@/lib/shared/access';
import type { CredentialSummary } from '@/lib/shared/types';
import { Card } from '../shell/page-header';
import { useProjects, writableProjects, projectLabel } from '../projects/use-projects';
import { useViewer } from '../auth/viewer';
import { Button } from '../ui/button';
import { FieldLabel, Select } from '../ui/inputs';

export function SetupCard({ onDone }: { onDone: (setup: AccessSetup) => void }) {
  const viewer = useViewer();
  const { projects } = useProjects();
  const [projectId, setProjectId] = useState('');
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [modelId, setModelId] = useState('');
  const [busy, setBusy] = useState(false);
  const writable = writableProjects(projects);
  useEffect(() => {
    api<{ credentials: CredentialSummary[] }>(`/api/credentials${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`)
      .then((r) => {
        const anthropic = r.credentials.filter((c) => c.type === 'core.anthropicApi');
        setCredentials(anthropic);
        setModelId((current) => (anthropic.some((c) => c.id === current) ? current : ''));
      })
      .catch(() => setCredentials([]));
  }, [projectId]);

  const install = async () => {
    setBusy(true);
    try {
      const setup = await accessApi.install({ ...(projectId && { projectId }), ...(modelId && { modelCredentialId: modelId }) });
      toast.success('Access requests are set up');
      onDone(setup);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="max-w-[560px]" >
      <div data-testid="access-setup" className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-full border border-hair bg-wl text-t2"><KeyRound className="size-[18px]" /></span>
          <div className="min-w-0">
            <p className="text-[15px] font-semibold text-t1">Set up access requests</p>
            <p className="text-[13px] leading-snug text-t2">
              People ask for a GitHub team, a Google group or anything done by hand, for a time they name. The approver you choose in each entry decides, and Landflow takes the access back when the time ends. One click installs the two flows that do it.
            </p>
          </div>
        </div>
        <div>
          <FieldLabel>Project for the flows</FieldLabel>
          <Select aria-label="Project for the flows" value={projectId} onChange={(e) => setProjectId(e.target.value)} className="max-md:h-11">
            <option value="">{viewer ? 'My home project' : 'Home project'}</option>
            {writable.map((p) => (
              <option key={p.id} value={p.id}>{projectLabel(p, viewer?.id)}</option>
            ))}
          </Select>
        </div>
        <div>
          <FieldLabel>Anthropic key for the chat (optional)</FieldLabel>
          <Select aria-label="Anthropic key for the chat" value={modelId} onChange={(e) => setModelId(e.target.value)} className="max-md:h-11">
            <option value="">No chat for now</option>
            {credentials.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
          <p className="mt-1 text-[12px] text-t3">
            The chat lets people ask in plain words. It can only file a request. {credentials.length === 0 && <>Add an Anthropic key on <Link href="/credentials" className="text-ac hover:underline">Credentials</Link> first to turn it on.</>}
          </p>
        </div>
        <div>
          <Button variant="primary" loading={busy} onClick={install} data-testid="access-setup-go">Set up access requests</Button>
        </div>
      </div>
    </Card>
  );
}
