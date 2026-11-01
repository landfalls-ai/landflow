'use client';
/**
 * Deploy tab → kagent: deploy the published agent to a kagent cluster with the persona built here (instructions, skills,
 * name and description as the system prompt, the model, the tools), and see whether kagent still holds exactly that. The
 * runtime is the Harness it runs on: kagent's own, or Claude Code, which also loads the agent's Claude Code plugins.
 */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShipWheel, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import type { Agent, KagentHarness, KagentRuntime, KagentStatus } from '@/lib/shared/agents';
import { CredentialDialog } from '../credentials/credential-dialog';
import { useCredentials } from '../credentials/use-credentials';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { CopyButton } from '../ui/copy-button';
import { Input, Select } from '../ui/inputs';
import { Field, Section } from './dialog';

const KAGENT = 'core.kagentApi';
const CREATE = '__create__';

/** The agent's name as a kagent name (the server's kagentName). */
const slug = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '') || 'landflow-agent';

const RUNTIME_LABEL: Record<KagentRuntime, string> = { kagent: 'kagent (ADK)', claude: 'Claude Code', codex: 'Codex', byo: 'Own image' };
const SUPPORTED: KagentRuntime[] = ['kagent', 'claude'];

const FIELD_LABEL: Record<string, string> = {
  systemPrompt: 'System prompt',
  description: 'Description',
  tools: 'Tools',
  plugins: 'Claude Code plugins',
  modelConfig: 'Model reference',
  model: 'Model',
  template: 'Template',
  harness: 'Harness',
  egressPolicies: 'Network access',
  mcpServer: 'MCP server',
};

interface EgressPolicy {
  name: string;
  origins: string[];
}

function StatusBadge({ status, loading }: { status?: KagentStatus; loading: boolean }) {
  if (!status) return loading ? <Badge tone="muted">Checking…</Badge> : null;
  if (!status.deployed) return <Badge tone="muted">Not deployed</Badge>;
  if (status.error) return <Badge tone="danger">kagent unreachable</Badge>;
  if (status.drift.length) return <Badge tone="warning">Changed in kagent</Badge>;
  if (status.outdated) return <Badge tone="warning">v{status.version} in kagent</Badge>;
  return <Badge tone="success">In sync · v{status.version}</Badge>;
}

/** The namespace's EgressPolicies as toggles: what the agent's sandbox may reach beyond Landflow and its model. */
function NetworkAccess({ policies, value, onChange }: { policies: EgressPolicy[]; value: string[]; onChange: (names: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {policies.map((p) => {
        const on = value.includes(p.name);
        return (
          <button
            key={p.name}
            type="button"
            aria-pressed={on}
            title={p.origins.join('\n') || 'No origins'}
            onClick={() => onChange(on ? value.filter((n) => n !== p.name) : [...value, p.name])}
            className={cn('rounded-md border px-2 py-0.5 font-mono text-[11px]', on ? 'border-ac bg-acdim text-ac' : 'border-hair bg-wl text-t3 hover:text-t1')}
          >
            {p.name}
            <span className="ml-1 font-sans text-t3">{p.origins.length}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The cluster's Harnesses as runtime choices; the ones Landflow can't write agents for are shown, disabled. */
function RuntimeSelect({ id, harnesses, value, onChange, placeholder }: { id: string; harnesses: KagentHarness[]; value: string; onChange: (name: string) => void; placeholder?: string }) {
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {placeholder && <option value="">{placeholder}</option>}
      {harnesses.map((h) => (
        <option key={h.name} value={h.name} disabled={!SUPPORTED.includes(h.runtime)}>
          {RUNTIME_LABEL[h.runtime]} · {h.name}
          {SUPPORTED.includes(h.runtime) ? '' : ' (not supported)'}
        </option>
      ))}
    </Select>
  );
}

export function KagentCard({ agent, onAgent }: { agent: Agent; onAgent: (agent: Agent) => void }) {
  const { credentials } = useCredentials();
  const clusters = (credentials ?? []).filter((c) => c.type === KAGENT);
  const [status, setStatus] = useState<KagentStatus>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<'deploy' | 'remove'>();
  const [credentialId, setCredentialId] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [harnesses, setHarnesses] = useState<KagentHarness[]>();
  const [harnessError, setHarnessError] = useState<string>();
  const [harness, setHarness] = useState('');
  const [policies, setPolicies] = useState<EgressPolicy[]>();
  // Undefined until changed here: the deploy keeps the agent's list (or the cluster's).
  const [egress, setEgress] = useState<string[]>();

  const published = agent.published;
  const deployedAt = agent.kagent?.deployedAt;
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<{ status: KagentStatus; harnesses?: KagentHarness[]; harnessError?: string; egressPolicies?: EgressPolicy[] }>(`/api/agents/${agent.id}/kagent`);
      setStatus(result.status);
      if (result.status.deployed) {
        setHarnesses(result.harnesses);
        setHarnessError(result.harnessError);
        setHarness(result.status.harness?.name ?? '');
        setPolicies(result.egressPolicies);
        setEgress(undefined);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [agent.id]);
  // Again whenever a publish or a deploy wrote to kagent.
  useEffect(() => void load(), [load, published?.version, deployedAt]);
  useEffect(() => {
    if (!credentialId && clusters.length) setCredentialId(clusters[0].id);
  }, [clusters, credentialId]);
  // Before the first deploy: the chosen cluster's Harnesses, the credential's own first.
  const undeployed = status && !status.deployed;
  useEffect(() => {
    if (!undeployed || !credentialId) return;
    let live = true;
    api<{ harnesses?: KagentHarness[]; harnessError?: string; egressPolicies?: EgressPolicy[] }>(`/api/agents/${agent.id}/kagent?credentialId=${encodeURIComponent(credentialId)}`)
      .then((result) => {
        if (!live) return;
        setHarnesses(result.harnesses);
        setHarnessError(result.harnessError);
        setHarness('');
        setPolicies(result.egressPolicies);
        setEgress(undefined);
      })
      .catch((e: Error) => live && setHarnessError(e.message));
    return () => {
      live = false;
    };
  }, [agent.id, credentialId, undeployed]);
  const chosen = harnesses?.find((h) => h.name === harness);
  const plugins = published?.config.plugins ?? [];

  const deploy = async () => {
    setBusy('deploy');
    try {
      const moved = harness && harness !== status?.harness?.name ? { harness } : {};
      const network = egress ? { egressPolicies: egress } : {};
      const body = status?.deployed ? { ...moved, ...network } : { credentialId, name: name.trim() || slug(agent.name), ...(harness && { harness }), ...network };
      const result = await api<{ agent: Agent; status: KagentStatus; unavailable: string[] }>(`/api/agents/${agent.id}/kagent`, { method: 'PUT', json: body });
      onAgent(result.agent);
      setStatus(result.status);
      toast.success(`v${result.status.version} written to kagent as ${result.status.name}`);
      for (const note of result.unavailable) toast.warning(`Not on kagent: ${note}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const remove = async () => {
    setBusy('remove');
    try {
      const result = await api<{ agent: Agent; status: KagentStatus }>(`/api/agents/${agent.id}/kagent`, { method: 'DELETE' });
      onAgent(result.agent);
      setStatus(result.status);
      toast('Removed from kagent');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const deployed = status?.deployed;
  return (
    <Section
      icon={<ShipWheel className="size-4" />}
      title="kagent"
      description="Run the published agent on kagent with this persona: Landflow writes its instructions, skills, model and tools there, and writes them again on every publish."
      actions={
        <>
          <StatusBadge status={status} loading={loading} />
          {deployed && (
            <Button size="icon-sm" variant="ghost" aria-label="Check kagent again" title="Check kagent again" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            </Button>
          )}
        </>
      }
    >
      {!deployed ? (
        <div className="space-y-3">
          {!published && <p className="text-[12px] text-t3">Publish the agent first: kagent runs the published version.</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="kagent-cluster" label="kagent cluster" required hint={!clusters.length ? 'Create a kagent cluster credential: its Kubernetes API, namespace and harness.' : undefined}>
              <Select
                id="kagent-cluster"
                value={credentialId}
                onChange={(e) => {
                  if (e.target.value === CREATE) return setCreating(true);
                  setCredentialId(e.target.value);
                }}
              >
                <option value="">{clusters.length ? 'Select a cluster…' : 'No cluster yet'}</option>
                {clusters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                <option value={CREATE}>+ Create credential</option>
              </Select>
            </Field>
            <Field id="kagent-name" label="Name in kagent" hint="Lowercase letters, digits and dashes">
              <Input id="kagent-name" value={name} placeholder={slug(agent.name)} onChange={(e) => setName(e.target.value)} />
            </Field>
            {harnesses && harnesses.length > 0 && (
              <Field id="kagent-runtime" label="Runtime" hint={runtimeHint(chosen, plugins.length)}>
                <RuntimeSelect id="kagent-runtime" harnesses={harnesses} value={harness} onChange={setHarness} placeholder="The cluster’s default" />
              </Field>
            )}
            {policies && policies.length > 0 && (
              <Field id="kagent-network" label="Network access" hint={egress ? 'Beyond Landflow and the model, the sandbox reaches only these.' : 'None chosen: the cluster credential’s Egress Policies.'}>
                <NetworkAccess policies={policies} value={egress ?? []} onChange={setEgress} />
              </Field>
            )}
          </div>
          {harnessError && <p className="text-[12px] text-t3">The cluster’s Harnesses couldn’t be listed: {harnessError}</p>}
          <div className="flex justify-end">
            <Button variant="primary" size="sm" loading={busy === 'deploy'} disabled={!published || !credentialId || Boolean(busy)} onClick={() => void deploy()}>
              {busy !== 'deploy' && <ShipWheel className="size-3.5" />}
              Deploy v{published?.version ?? 1} to kagent
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[12px]">
            <dt className="text-t3">Agent</dt>
            <dd className="truncate font-mono text-t1">
              {status.namespace ? `${status.namespace}/` : ''}
              {status.name}
              <span className="font-sans text-t3"> · {status.credential?.name}</span>
            </dd>
            <dt className="text-t3">Version</dt>
            <dd className="text-t1">
              v{status.version}
              {status.deployedAt && <span className="text-t3"> · written {new Date(status.deployedAt).toLocaleString()}</span>}
              {status.outdated && published && <span className="text-warn"> · v{published.version} is published</span>}
            </dd>
            {status.harness && (
              <>
                <dt className="text-t3">Runtime</dt>
                <dd className="truncate text-t1">
                  {RUNTIME_LABEL[status.harness.runtime]}
                  <span className="font-mono text-t3"> · {status.harness.name}</span>
                </dd>
              </>
            )}
            {status.egressPolicies && status.egressPolicies.length > 0 && (
              <>
                <dt className="text-t3">Network</dt>
                <dd className="truncate font-mono text-t1">{status.egressPolicies.join(', ')}</dd>
              </>
            )}
            {status.plugins && status.plugins.length > 0 && (
              <>
                <dt className="text-t3">Plugins</dt>
                <dd className="flex min-w-0 flex-wrap gap-1">
                  {status.plugins.map((p) => (
                    <span key={p.id} className="rounded border border-hair bg-wl px-1.5 font-mono text-[11px] text-t2" title={`${p.url}${p.path ? ` · ${p.path}` : ''} @ ${p.commit}`}>
                      {p.id} @ {p.commit.slice(0, 7)}
                    </span>
                  ))}
                </dd>
              </>
            )}
            {status.ready && (
              <>
                <dt className="text-t3">Status</dt>
                <dd className={cn('truncate', status.ready.status ? 'text-gn' : 'text-warn')} title={status.ready.message}>
                  {status.ready.status ? 'Ready' : (status.ready.reason ?? 'Not ready')}
                  {status.ready.message && <span className="text-t3"> · {status.ready.message}</span>}
                </dd>
              </>
            )}
            {status.a2aUrl && (
              <>
                <dt className="self-center text-t3">A2A</dt>
                <dd className="flex min-w-0 items-center gap-1">
                  <span className="truncate font-mono text-t1">{status.a2aUrl}</span>
                  <CopyButton text={status.a2aUrl} label="Copy the A2A URL" />
                </dd>
              </>
            )}
          </dl>
          {status.error && <p className="rounded-lg border border-rdbd bg-rddim px-3 py-2 text-[12px] text-rd">{status.error}</p>}
          {status.drift.length > 0 && (
            <div className="space-y-1.5 rounded-lg border border-warnbd bg-warndim px-3 py-2">
              <p className="text-[12px] font-semibold text-warn">kagent’s copy differs from this agent’s v{status.version}. Redeploy to write Landflow’s again.</p>
              {status.drift.map((d) => (
                <details key={d.field} className="text-[12px]">
                  <summary className="cursor-pointer text-t1">{FIELD_LABEL[d.field] ?? `${d.field} is missing`}</summary>
                  <div className="mt-1 grid gap-2 sm:grid-cols-2">
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-hair bg-wl p-2 font-mono text-[11px] text-t2">
                      <span className="mb-1 block font-sans font-semibold text-t3">Landflow</span>
                      {d.landflow}
                    </pre>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-hair bg-wl p-2 font-mono text-[11px] text-t2">
                      <span className="mb-1 block font-sans font-semibold text-t3">kagent</span>
                      {d.kagent ?? '(none)'}
                    </pre>
                  </div>
                </details>
              ))}
            </div>
          )}
          {policies && policies.length > 0 && (
            <Field id="kagent-network-move" label="Network access" hint={egress ? 'Redeploying writes this list: beyond Landflow and the model, the sandbox reaches only these.' : 'Beyond Landflow and the model, what the sandbox may reach. Change it, then redeploy.'}>
              <NetworkAccess policies={policies} value={egress ?? status.egressPolicies ?? []} onChange={setEgress} />
            </Field>
          )}
          {harnesses && harnesses.length > 1 && (
            <Field id="kagent-move" label="Runtime" hint={harness !== status.harness?.name ? `Redeploying moves the agent to ${harness}.` : (runtimeHint(chosen, plugins.length) ?? undefined)}>
              <RuntimeSelect id="kagent-move" harnesses={harnesses} value={harness} onChange={setHarness} />
            </Field>
          )}
          {status.systemPrompt !== undefined && (
            <details className="text-[12px]">
              <summary className="cursor-pointer text-t2">The system prompt kagent holds</summary>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-hair bg-wl p-2 font-mono text-[11px] text-t2">{status.systemPrompt}</pre>
            </details>
          )}
          <div className="flex flex-wrap justify-end gap-1.5">
            <Button variant="ghost" size="sm" loading={busy === 'remove'} disabled={Boolean(busy)} onClick={() => void remove()}>
              {busy !== 'remove' && <Trash2 className="size-3.5" />}
              Remove from kagent
            </Button>
            <Button variant={status.inSync ? 'outline' : 'primary'} size="sm" loading={busy === 'deploy'} disabled={!published || Boolean(busy)} onClick={() => void deploy()}>
              {busy !== 'deploy' && <ShipWheel className="size-3.5" />}
              Redeploy v{published?.version}
            </Button>
          </div>
        </div>
      )}
      {creating && <CredentialDialog allowedTypes={[KAGENT]} onClose={() => setCreating(false)} onSaved={(c) => setCredentialId(c.id)} />}
    </Section>
  );
}

/** What choosing a runtime means for this agent. */
function runtimeHint(harness: KagentHarness | undefined, plugins: number): string | undefined {
  if (harness?.runtime !== 'claude') return undefined;
  return `Claude Code runs with its own tools (files, shell) in kagent’s sandbox${plugins ? ` and loads the agent’s ${plugins} plugin${plugins === 1 ? '' : 's'}` : ''}.`;
}
