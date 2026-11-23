'use client';
/**
 * Settings → MCP → Policy hooks (C14): the webhooks asked allow or deny before an outbound MCP tool call, resource read
 * or prompt. The list, the Test button and the dialog (a bottom sheet on a phone, as every Dialog is). The credential is
 * picked, never typed: its token stays in the vault. No zod here (the client bundle and the CSP): the server validates.
 */
import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { confirmAction } from '@/components/ui/confirm';
import { DEFAULT_HOOK_TIMEOUT_MS, FAILURE_WORDS, MAX_HOOK_TIMEOUT_MS, MCP_POLICY_METHODS, METHOD_WORDS, MIN_HOOK_TIMEOUT_MS, matchLine, type McpPolicyHookView, type McpPolicyMethod } from '@/lib/shared/mcp-policy';
import type { CredentialSummary } from '@/lib/shared/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, Field } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Checkbox, Input, Select, Switch, Textarea } from '@/components/ui/inputs';

/** What a Test answered, as the route sends it. */
export interface HookTestResult {
  ok: boolean;
  decision?: 'allow' | 'deny';
  reason?: string;
  ruleId?: string;
  error?: string;
  ms: number;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** One line for a Test result: what the service said, or why it did not. */
export const testLine = (result: HookTestResult): string =>
  result.ok ? `${result.decision === 'deny' ? 'Deny' : 'Allow'}${result.reason ? `: ${result.reason}` : ''}${result.ruleId ? ` (${result.ruleId})` : ''} in ${result.ms} ms` : `No answer: ${result.error ?? 'unknown'}`;

/** The list: pure, so it renders the same on the server in a test. */
export function PolicyHooksView({
  hooks,
  results = {},
  testing,
  onAdd,
  onEdit,
  onRemove,
  onToggle,
  onTest,
}: {
  hooks: McpPolicyHookView[];
  results?: Record<string, HookTestResult>;
  testing?: string;
  onAdd?: () => void;
  onEdit?: (hook: McpPolicyHookView) => void;
  onRemove?: (hook: McpPolicyHookView) => void;
  onToggle?: (hook: McpPolicyHookView, enabled: boolean) => void;
  onTest?: (hook: McpPolicyHookView) => void;
}) {
  if (!hooks.length) {
    return (
      <EmptyState
        compact
        icon={<ShieldCheck />}
        title="No policy hooks: MCP calls go out as the agent wrote them"
        hint="A hook is a service of yours that says allow or deny before a call leaves, with the server, the tool and the arguments."
        action={
          <Button variant="outline" onClick={onAdd}>
            <Plus className="size-3.5" /> New policy hook
          </Button>
        }
      />
    );
  }
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-hair rounded-lg border border-hair">
        {hooks.map((hook) => {
          const result = results[hook.id];
          return (
            <li key={hook.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5">
              <div className="min-w-0 flex-1 basis-60">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold text-t1">{hook.name}</span>
                  <Badge tone={hook.failureMode === 'closed' ? 'warning' : 'muted'} title={FAILURE_WORDS[hook.failureMode]}>
                    {hook.failureMode === 'closed' ? 'Blocks if silent' : 'Lets through if silent'}
                  </Badge>
                  {!hook.enabled && <Badge tone="muted">Off</Badge>}
                </div>
                <p className="mt-0.5 break-all font-mono text-[11px] text-t3">{hostOf(hook.url)}</p>
                <p className="mt-0.5 text-[12px] leading-snug text-t2">Asked before {matchLine(hook)}</p>
                {result && (
                  <p role="status" className={result.ok ? 'mt-1 text-[12px] text-gn' : 'mt-1 text-[12px] text-rd'}>
                    {testLine(result)}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Switch checked={hook.enabled} onChange={(value) => onToggle?.(hook, value)} label={`${hook.name} is on`} />
                <Button size="sm" variant="outline" onClick={() => onTest?.(hook)} loading={testing === hook.id}>
                  Test
                </Button>
                <Button size="icon-sm" variant="ghost" onClick={() => onEdit?.(hook)} aria-label={`Edit ${hook.name}`}>
                  <Pencil className="size-3.5" />
                </Button>
                <Button size="icon-sm" variant="ghost" onClick={() => onRemove?.(hook)} aria-label={`Remove ${hook.name}`}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <Button variant="outline" onClick={onAdd}>
        <Plus className="size-3.5" /> New policy hook
      </Button>
    </div>
  );
}

const split = (text: string) => [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];

function HookDialog({ hook, credentials, projects, onClose, onSaved }: { hook?: McpPolicyHookView; credentials: CredentialSummary[]; projects: Array<{ id: string; name: string }>; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(hook?.name ?? '');
  const [url, setUrl] = useState(hook?.url ?? '');
  const [auth, setAuth] = useState<'hmac' | 'bearer' | 'none'>(hook?.auth ?? 'hmac');
  const [credentialId, setCredentialId] = useState(hook?.credential?.id ?? '');
  const [timeoutMs, setTimeoutMs] = useState(String(hook?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS));
  // A new hook starts where the deployment would: the server picks the default (closed in production) when this is left alone.
  const [failureMode, setFailureMode] = useState<'closed' | 'open' | ''>(hook?.failureMode ?? '');
  const [hosts, setHosts] = useState((hook?.match.hosts ?? []).join(', '));
  const [pathPrefix, setPathPrefix] = useState(hook?.match.pathPrefix ?? '');
  const [tools, setTools] = useState((hook?.match.tools ?? []).join(', '));
  const [methods, setMethods] = useState<McpPolicyMethod[]>(hook?.match.methods ?? ['tools/call']);
  const [projectIds, setProjectIds] = useState<string[]>(hook?.match.projects ?? []);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const bearerCredentials = credentials.filter((c) => c.type === 'core.httpBearerAuth' || c.type.endsWith('.httpBearerAuth'));
  const toggle = <T,>(list: T[], value: T, on: boolean) => (on ? [...list, value] : list.filter((v) => v !== value));

  const save = async () => {
    setBusy(true);
    setProblem('');
    try {
      const match = { hosts: split(hosts), tools: split(tools), methods, projects: projectIds };
      const common = { name: name.trim(), url: url.trim(), auth, timeoutMs: Number(timeoutMs), ...(failureMode && { failureMode }) };
      const credential = auth === 'none' ? undefined : credentialId || undefined;
      // A change clears what is emptied (null); a new hook just leaves it out.
      if (hook) await api(`/api/settings/mcp/policy-hooks/${hook.id}`, { method: 'PATCH', json: { ...common, credentialId: credential ?? null, match: { ...match, pathPrefix: pathPrefix.trim() || null } } });
      else await api('/api/settings/mcp/policy-hooks', { method: 'POST', json: { ...common, ...(credential && { credentialId: credential }), match: { ...match, ...(pathPrefix.trim() && { pathPrefix: pathPrefix.trim() }) } } });
      toast.success(hook ? 'Policy hook saved' : 'Policy hook created');
      onSaved();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={hook ? 'Edit policy hook' : 'New policy hook'}
      subtitle="Asked allow or deny before a matching MCP call leaves. Arguments are sent with secrets masked."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={!name.trim() || !url.trim() || methods.length === 0}>
            {hook ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field id="hook-name" label="Name" required>
          <Input id="hook-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Finance policy" />
        </Field>
        <Field id="hook-url" label="Service URL" required hint="Landflow posts the call here. In production a private address needs LANDFLOW_OUTBOUND_ALLOW.">
          <Input id="hook-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://policy.example.com/decide" spellCheck={false} inputMode="url" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="hook-auth" label="Signing">
            <Select id="hook-auth" value={auth} onChange={(e) => setAuth(e.target.value as typeof auth)}>
              <option value="hmac">HMAC signature</option>
              <option value="bearer">Bearer token</option>
              <option value="none">None</option>
            </Select>
          </Field>
          {auth !== 'none' && (
            <Field id="hook-credential" label="Credential" hint="A Bearer Auth credential; its token is the signing key.">
              <Select id="hook-credential" value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
                <option value="">Choose a credential</option>
                {bearerCredentials.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="hook-timeout" label="Wait at most (ms)" hint={`${MIN_HOOK_TIMEOUT_MS} to ${MAX_HOOK_TIMEOUT_MS}`}>
            <Input id="hook-timeout" type="number" min={MIN_HOOK_TIMEOUT_MS} max={MAX_HOOK_TIMEOUT_MS} step={100} value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} />
          </Field>
          <Field id="hook-failure" label="When the service is silent">
            <Select id="hook-failure" value={failureMode} onChange={(e) => setFailureMode(e.target.value as typeof failureMode)}>
              {!hook && <option value="">Default for this deployment</option>}
              <option value="closed">{FAILURE_WORDS.closed}</option>
              <option value="open">{FAILURE_WORDS.open}</option>
            </Select>
          </Field>
        </div>
        <fieldset className="space-y-3 rounded-lg border border-hair p-3">
          <legend className="px-1 text-[12px] font-semibold text-t2">Ask only about</legend>
          <Field id="hook-hosts" label="Server hosts" hint="Separate with commas or spaces; * matches any. Empty: every server.">
            <Input id="hook-hosts" value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="mcp.example.com, *.internal" spellCheck={false} />
          </Field>
          <Field id="hook-path" label="Server path starts with">
            <Input id="hook-path" value={pathPrefix} onChange={(e) => setPathPrefix(e.target.value)} placeholder="/github" spellCheck={false} />
          </Field>
          <Field id="hook-tools" label="Tool patterns" hint="create_*, delete_*. Empty: every tool.">
            <Textarea id="hook-tools" rows={2} value={tools} onChange={(e) => setTools(e.target.value)} spellCheck={false} />
          </Field>
          <div>
            <p className="mb-1 text-[12px] font-semibold text-t2">Kinds of call</p>
            <div className="flex flex-wrap gap-x-4">
              {MCP_POLICY_METHODS.map((method) => (
                <Checkbox key={method} checked={methods.includes(method)} onChange={(on) => setMethods((list) => toggle(list, method, on))} label={METHOD_WORDS[method]} />
              ))}
            </div>
          </div>
          {projects.length > 0 && (
            <div>
              <p className="mb-1 text-[12px] font-semibold text-t2">Projects</p>
              <p className="mb-1 text-[12px] text-t3">None ticked: calls from every project.</p>
              <div className="max-h-32 overflow-y-auto">
                {projects.map((project) => (
                  <Checkbox key={project.id} checked={projectIds.includes(project.id)} onChange={(on) => setProjectIds((list) => toggle(list, project.id, on))} label={project.name} />
                ))}
              </div>
            </div>
          )}
        </fieldset>
        {problem && (
          <p role="alert" className="text-[12px] text-rd">
            {problem}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** The section's content (mounted in Settings → MCP by `McpSections`). */
export function PolicyHooks() {
  const [hooks, setHooks] = useState<McpPolicyHookView[]>();
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<McpPolicyHookView | 'new'>();
  const [results, setResults] = useState<Record<string, HookTestResult>>({});
  const [testing, setTesting] = useState<string>();

  const load = useCallback(async () => {
    try {
      const [list, creds, projs] = await Promise.all([
        api<{ hooks: McpPolicyHookView[] }>('/api/settings/mcp/policy-hooks'),
        api<{ credentials: CredentialSummary[] }>('/api/credentials').catch(() => ({ credentials: [] as CredentialSummary[] })),
        api<{ projects: Array<{ id: string; name: string }> }>('/api/projects').catch(() => ({ projects: [] })),
      ]);
      setHooks(list.hooks);
      setCredentials(creds.credentials);
      setProjects(projs.projects);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const test = async (hook: McpPolicyHookView) => {
    setTesting(hook.id);
    try {
      const result = await api<HookTestResult>(`/api/settings/mcp/policy-hooks/${hook.id}/test`, { method: 'POST' });
      setResults((r) => ({ ...r, [hook.id]: result }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTesting(undefined);
    }
  };

  const toggle = async (hook: McpPolicyHookView, enabled: boolean) => {
    try {
      await api(`/api/settings/mcp/policy-hooks/${hook.id}`, { method: 'PATCH', json: { enabled } });
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const remove = async (hook: McpPolicyHookView) => {
    if (!(await confirmAction(`Remove “${hook.name}”? Calls it matched go out without it.`, { action: 'Remove', danger: true }))) return;
    try {
      await api(`/api/settings/mcp/policy-hooks/${hook.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (error) return <p className="text-[12px] text-rd">Couldn’t load the policy hooks: {error}</p>;
  if (!hooks) return <p className="text-[12px] text-t3">Loading…</p>;
  return (
    <>
      <PolicyHooksView hooks={hooks} results={results} testing={testing} onAdd={() => setEditing('new')} onEdit={setEditing} onRemove={(h) => void remove(h)} onToggle={(h, v) => void toggle(h, v)} onTest={(h) => void test(h)} />
      {editing && (
        <HookDialog
          hook={editing === 'new' ? undefined : editing}
          credentials={credentials}
          projects={projects}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            void load();
          }}
        />
      )}
    </>
  );
}
