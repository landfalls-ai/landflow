'use client';
/**
 * Settings → Networks (C29, docs/network-runners.md): the networks an HTTP Request node can run in, each with its runners
 * (online, offline or revoked; version and last seen) and the workflows that use it. Register runner shows the token and
 * a `docker run` line once; Revoke asks first. A network is instance-wide or bound to one project. Writes are the
 * built-in admin's (the server checks); the list refreshes every few seconds while it is open, so a runner that just
 * came up turns online without a reload. A phone stacks the cards and opens the dialogs as bottom sheets.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Network, Plus, ShieldAlert, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { plural, timeAgo } from '@/lib/client/format';
import { checkAllowList } from '@/lib/shared/ip-entry';
import { runnerDockerCommand, type NetworkView, type NetworksResponse, type RegisteredRunner, type RunnerView } from '@/lib/shared/networks';
import { isBuiltInAdmin } from '@/lib/shared/auth';
import { useViewer } from '@/components/auth/viewer';
import { Card } from '@/components/shell/page-header';
import { Badge, StatusDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { confirmAction } from '@/components/ui/confirm';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, Field } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, SectionLabel, Select } from '@/components/ui/inputs';

const STATUS_WORDS = { online: 'Online', offline: 'Offline', revoked: 'Revoked' } as const;

/** The address a runner in a container should dial: this page's origin, with the Docker name for the host when it is local. */
export function hostUrlForRunner(origin: string): string {
  try {
    const url = new URL(origin);
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? `${url.protocol}//host.docker.internal${url.port ? `:${url.port}` : ''}` : url.origin;
  } catch {
    return origin;
  }
}

function NetworkDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState('');
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api<{ projects: Array<{ id: string; name: string }> }>('/api/projects')
      .then((r) => setProjects(r.projects))
      .catch(() => setProjects([]));
  }, []);
  const save = async () => {
    setSaving(true);
    try {
      await api('/api/settings/networks', { method: 'POST', json: { name: name.trim(), ...(description.trim() && { description: description.trim() }), ...(projectId && { projectId }) } });
      toast.success(`Created ${name.trim()}`);
      onSaved();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      title="New network"
      subtitle="A place Landflow can’t reach by itself: an office network, a VPC."
      icon={<Network className="size-4 text-t3" strokeWidth={1.8} />}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!name.trim()} onClick={() => void save()}>
            Create network
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field id="network-name" label="Name" required>
          <Input id="network-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Office" autoFocus />
        </Field>
        <Field id="network-description" label="What it is">
          <Input id="network-description" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} placeholder="The Tel Aviv office network" />
        </Field>
        <Field id="network-project" label="Who can use it" hint="A project’s network is for that project’s workflows only.">
          <Select id="network-project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Any workflow</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                Only {project.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}

function RunnerDialog({ network, onClose, onRegistered }: { network: NetworkView; onClose: () => void; onRegistered: (registered: RegisteredRunner) => void }) {
  const [name, setName] = useState('');
  const [ips, setIps] = useState('');
  const [saving, setSaving] = useState(false);
  const list = ips.split(/[\s,]+/).filter(Boolean);
  const checked = checkAllowList(list);
  const save = async () => {
    setSaving(true);
    try {
      const registered = await api<RegisteredRunner>(`/api/settings/networks/${network.id}/runners`, { method: 'POST', json: { name: name.trim(), ...(list.length && { allowedIps: list }) } });
      onRegistered(registered);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      title={`Register a runner in ${network.name}`}
      subtitle="The runner gets a token of its own, shown once. Revoke it here at any time."
      icon={<Network className="size-4 text-t3" strokeWidth={1.8} />}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!name.trim() || !checked.ok} onClick={() => void save()}>
            Register runner
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field id="runner-name" label="Name" required>
          <Input id="runner-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="office-1" autoFocus />
        </Field>
        <Field id="runner-ips" label="Connect only from" hint={checked.ok ? 'Addresses or ranges, separated by commas. Empty: any address.' : checked.problem}>
          <Input id="runner-ips" value={ips} onChange={(e) => setIps(e.target.value)} placeholder="203.0.113.0/24" aria-invalid={!checked.ok} />
        </Field>
      </div>
    </Dialog>
  );
}

function RunnerRow({ runner, onRevoke }: { runner: RunnerView; onRevoke?: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0">
      <StatusDot status={runner.status === 'online' ? 'online' : runner.status === 'revoked' ? 'error' : 'offline'} pulse={runner.status === 'online'} />
      <div className="min-w-0 flex-1 basis-48">
        <div className="flex flex-wrap items-center gap-x-2 text-[13px] font-semibold text-t1">
          {runner.name}
          <span className="text-[12px] font-normal text-t3">{STATUS_WORDS[runner.status]}</span>
          <span className="font-mono text-[11px] font-normal text-t3">…{runner.hint}</span>
        </div>
        <div className="text-[12px] text-t3">
          {runner.version ? `Version ${runner.version} · ` : ''}
          {runner.status === 'revoked' ? `revoked ${timeAgo(runner.revokedAt)}` : runner.lastSeenAt ? `seen ${timeAgo(runner.lastSeenAt)}` : 'not seen yet'}
          {runner.address ? ` · from ${runner.address}` : ''}
          {runner.allowedIps.length ? ` · only from ${runner.allowedIps.join(', ')}` : ''}
        </div>
      </div>
      {onRevoke && runner.status !== 'revoked' && (
        <Button size="sm" variant="ghost" onClick={onRevoke} aria-label={`Revoke ${runner.name}`}>
          Revoke
        </Button>
      )}
    </li>
  );
}

/** `networks` is what the first render shows before the list loads (tests render it on the server). */
export function NetworksSettings({ networks: given }: { networks?: NetworkView[] }) {
  const viewer = useViewer();
  const [networks, setNetworks] = useState<NetworkView[] | undefined>(given);
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [registering, setRegistering] = useState<NetworkView>();
  const [registered, setRegistered] = useState<{ token: string; runner: RunnerView; network: string }>();
  const load = useCallback(
    () =>
      api<NetworksResponse>('/api/settings/networks')
        .then((r) => setNetworks(r.networks))
        .catch((e: Error) => setError(e.message)),
    [],
  );
  useEffect(() => {
    if (given) return;
    void load();
    // Runners come online and go offline while the page is open.
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, [given, load]);

  const manage = isBuiltInAdmin(viewer);
  const revoke = async (network: NetworkView, runner: RunnerView) => {
    if (!(await confirmAction(`Revoke ${runner.name}? Its token stops working within seconds and a call it is making fails.`, { action: 'Revoke', danger: true }))) return;
    try {
      await api(`/api/settings/networks/${network.id}/runners/${runner.id}`, { method: 'DELETE' });
      toast.success(`Revoked ${runner.name}`);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const remove = async (network: NetworkView) => {
    const used = network.workflows.length ? ` ${plural(network.workflows.length, 'workflow')} run${network.workflows.length === 1 ? 's' : ''} in it and will fail.` : '';
    if (!(await confirmAction(`Delete ${network.name}? Its ${plural(network.runners.length, 'runner')} will be revoked.${used}`, { action: 'Delete', danger: true }))) return;
    try {
      await api(`/api/settings/networks/${network.id}`, { method: 'DELETE' });
      toast.success(`Deleted ${network.name}`);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (error) return <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>;
  if (!networks) return <div className="h-56 rounded-2xl border border-hair bg-sf animate-pulse-soft" />;

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-t2">
        A network runner is a small process you start inside a private network. It dials out to Landflow (no inbound rule), and an HTTP Request node set to <b className="font-semibold text-t1">Run In</b> that network makes its call from there. A runner reaches only what its own allow-list names.
      </p>

      {registered && (
        <Card className="space-y-2 border-acbd px-5 py-4 animate-fade-up">
          <div className="flex items-start gap-2 text-[13px]">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" strokeWidth={1.8} />
            <span className="min-w-0 flex-1 text-t2">
              <span className="font-semibold text-t1">Copy the token of “{registered.runner.name}” now.</span> You won’t see it again; Landflow keeps only a hash of it.
            </span>
            <button onClick={() => setRegistered(undefined)} aria-label="Dismiss" className="text-t3 hover:text-t1">
              <X className="size-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-1 rounded-[10px] border border-hair bg-wl py-1 pl-3 pr-1">
            <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-t1" data-testid="new-runner-token">
              {registered.token}
            </code>
            <CopyButton text={registered.token} label="Copy token" />
          </div>
          <div className="text-[12px] text-t3">Start it in the network (set LANDFLOW_RUNNER_ALLOW to the hosts and ranges it may reach; empty refuses everything):</div>
          <div className="flex items-start gap-1 rounded-[10px] border border-hair bg-wl py-1 pl-3 pr-1">
            <code className="min-w-0 flex-1 break-all py-1 font-mono text-[11.5px] leading-snug text-t1">{runnerDockerCommand(hostUrlForRunner(typeof window === 'undefined' ? '' : window.location.origin), registered.token, registered.runner.name)}</code>
            <CopyButton text={runnerDockerCommand(hostUrlForRunner(typeof window === 'undefined' ? '' : window.location.origin), registered.token, registered.runner.name)} label="Copy command" />
          </div>
        </Card>
      )}

      <div className="flex items-center gap-2">
        <SectionLabel>Networks</SectionLabel>
        {manage && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" /> New network
          </Button>
        )}
      </div>

      {networks.length === 0 ? (
        <EmptyState compact title="No networks yet" hint="Create one for each private network a flow needs to reach, then register a runner in it." />
      ) : (
        networks.map((network) => (
          <Card key={network.id} className="space-y-3 px-5 py-4">
            <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
              <Network className="mt-0.5 size-4 shrink-0 text-t3" strokeWidth={1.8} />
              <div className="min-w-0 flex-1 basis-56">
                <div className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-t1">
                  {network.name}
                  <Badge tone={network.projectId ? 'accent' : 'muted'}>{network.projectName ? `Only ${network.projectName}` : network.projectId ? 'One project' : 'Any workflow'}</Badge>
                </div>
                {network.description && <div className="text-[12px] text-t3">{network.description}</div>}
              </div>
              {manage && (
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setRegistering(network)}>
                    <Plus className="size-3.5" /> Register runner
                  </Button>
                  <Button size="icon-sm" variant="ghost" onClick={() => void remove(network)} aria-label={`Delete ${network.name}`} title="Delete">
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              )}
            </div>
            {network.runners.length === 0 ? (
              <p className="text-[12px] text-t3">No runner yet. Until one is online, a node that runs here fails with “No runner online for network {network.name}”.</p>
            ) : (
              <ul className="divide-y divide-hair">
                {network.runners.map((runner) => (
                  <RunnerRow key={runner.id} runner={runner} onRevoke={manage ? () => void revoke(network, runner) : undefined} />
                ))}
              </ul>
            )}
            <div className="text-[12px] text-t3">
              {network.workflows.length === 0 ? (
                'No workflow runs in it yet.'
              ) : (
                <>
                  Used by{' '}
                  {network.workflows.map((workflow, i) => (
                    <span key={workflow.id}>
                      {i > 0 && ', '}
                      <Link href={`/workflows/${workflow.id}`} className="text-t2 underline">
                        {workflow.name}
                      </Link>
                    </span>
                  ))}
                </>
              )}
            </div>
          </Card>
        ))
      )}
      {!manage && <p className="text-[12px] text-t3">Only an owner or admin changes networks and runners.</p>}
      {creating && <NetworkDialog onClose={() => setCreating(false)} onSaved={() => void load()} />}
      {registering && (
        <RunnerDialog
          network={registering}
          onClose={() => setRegistering(undefined)}
          onRegistered={(result) => {
            setRegistered({ token: result.token, runner: result.runner, network: registering.name });
            void load();
          }}
        />
      )}
    </div>
  );
}
