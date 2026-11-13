'use client';
/**
 * Settings → Source control (owners and admins): connect a Git repository (a local path or a remote URL, a branch and
 * optionally a sub-directory), then Push (export the workflows, folders, variables and table schemas as files, commit
 * with a message and push) or Pull (fetch the branch and apply its files: a preview first, with conflicts against
 * edits made here since the last sync). Push can commit only the workflows you pick. SSH remotes use the host account's keys, or
 * a private key from an "SSH private key" credential with the server's host keys pinned (Fetch host key shows their
 * fingerprints to check). Credentials are never written to the repository, only referenced by name.
 */
import { useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, GitBranch, Save, TriangleAlert, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/client/api';
import type { CredentialSummary } from '@/lib/shared/types';
import type { HostKeyScan, SourceControlPullResult, SourceControlPushResult, SourceControlView, SyncChange } from '@/lib/shared/sync';
import { Card } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldLabel, Input, SectionLabel, Select, Switch, Textarea } from '@/components/ui/inputs';
import { dayTime, plural } from '@/lib/client/format';

interface Draft {
  repository: string;
  branch: string;
  directory: string;
  credentialId: string;
  sshCredentialId: string;
  knownHosts: string;
  username: string;
  authorName: string;
  authorEmail: string;
  includeVariableValues: boolean;
}

const draftOf = (view?: SourceControlView): Draft => ({
  repository: view?.config?.repository ?? '',
  branch: view?.config?.branch ?? 'main',
  directory: view?.config?.directory ?? '',
  credentialId: view?.config?.credentialId ?? '',
  sshCredentialId: view?.config?.sshCredentialId ?? '',
  knownHosts: view?.config?.knownHosts ?? '',
  username: view?.config?.username ?? 'x-access-token',
  authorName: view?.config?.authorName ?? 'Landflow',
  authorEmail: view?.config?.authorEmail ?? 'landflow@localhost',
  includeVariableValues: view?.config?.includeVariableValues ?? false,
});

const when = (iso?: string) => (iso ? dayTime(iso) : 'never');

function Changes({ changes }: { changes: SyncChange[] }) {
  if (!changes.length) return <p className="text-[13px] text-t2">Nothing to change: the instance matches the branch.</p>;
  return (
    <ul className="divide-y divide-hair text-[13px]">
      {changes.map((c) => (
        <li key={`${c.kind}:${c.id}:${c.action}`} className="flex items-center gap-2 py-1.5">
          <Badge tone={c.conflict ? 'danger' : c.skipped ? 'muted' : c.action === 'delete' ? 'warning' : c.action === 'create' ? 'success' : 'accent'}>{c.action}</Badge>
          <span className="text-t3">{c.kind}</span>
          <span className="min-w-0 truncate text-t1">{c.name}</span>
          <span className="ml-auto truncate text-[12px] text-t3">{c.conflict ?? (c.skipped ? 'needs “delete missing”' : c.fields?.join(', '))}</span>
        </li>
      ))}
    </ul>
  );
}

export function SourceControlSettings() {
  const [view, setView] = useState<SourceControlView>();
  const [draft, setDraft] = useState<Draft>(draftOf());
  const [creds, setCreds] = useState<CredentialSummary[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<'save' | 'push' | 'preview' | 'pull' | 'disconnect' | 'hostkeys'>();
  const [workflows, setWorkflows] = useState<Array<{ id: string; name: string }>>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [scan, setScan] = useState<HostKeyScan>();
  const [message, setMessage] = useState('');
  const [prune, setPrune] = useState(false);
  const [preview, setPreview] = useState<SourceControlPullResult>();
  const [lastPush, setLastPush] = useState<SourceControlPushResult>();

  const load = () =>
    api<SourceControlView>('/api/source-control')
      .then((v) => {
        setView(v);
        setDraft(draftOf(v));
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
    api<{ credentials: CredentialSummary[] }>('/api/credentials')
      .then((r) => setCreds(r.credentials))
      .catch(() => setCreds([]));
    api<{ workflows: Array<{ id: string; name: string }> }>('/api/workflows')
      .then((r) => setWorkflows(r.workflows))
      .catch(() => setWorkflows([]));
  }, []);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(view));

  const run = async <T,>(kind: NonNullable<typeof busy>, fn: () => Promise<T>) => {
    setBusy(kind);
    try {
      return await fn();
    } catch (e) {
      const body = (e as ApiError).body as SourceControlPullResult | undefined;
      if (body?.changes) setPreview(body);
      toast.error((e as Error).message);
      return undefined;
    } finally {
      setBusy(undefined);
    }
  };

  const save = () =>
    run('save', async () => {
      const next = await api<SourceControlView>('/api/source-control', { method: 'PUT', json: { ...draft, credentialId: draft.credentialId || null, sshCredentialId: draft.sshCredentialId || null } });
      setView(next);
      setDraft(draftOf(next));
      toast.success('Source control saved');
    });

  const [onlyPicked, setOnlyPicked] = useState(false);
  const fetchHostKeys = () =>
    run('hostkeys', async () => {
      setScan(await api<HostKeyScan>('/api/source-control/host-keys', { method: 'POST', json: { repository: draft.repository } }));
    });

  const push = () =>
    run('push', async () => {
      const result = await api<SourceControlPushResult>('/api/source-control/push', { method: 'POST', json: { message: message.trim() || undefined, ...(onlyPicked && { workflowIds: picked }) } });
      setLastPush(result);
      setMessage('');
      toast.success(result.committed ? `Pushed ${result.commit?.slice(0, 7)} (${plural(result.files.length, 'file')})` : 'Nothing to commit');
      await load();
    });

  const pull = (dryRun: boolean, force = false) =>
    run(dryRun ? 'preview' : 'pull', async () => {
      const result = await api<SourceControlPullResult>('/api/source-control/pull', { method: 'POST', json: { dryRun, prune, force } });
      setPreview(dryRun ? result : undefined);
      if (!dryRun) {
        toast.success(result.appliedCount ? `Applied ${plural(result.appliedCount, 'change')} from ${result.commit.slice(0, 7)}` : 'Already up to date');
        await load();
      }
    });

  const disconnect = () =>
    run('disconnect', async () => {
      const next = await api<SourceControlView>('/api/source-control', { method: 'DELETE' });
      setView(next);
      setDraft(draftOf(next));
      setPreview(undefined);
      toast.success('Disconnected: the repository is untouched');
    });

  if (!view) {
    return error ? <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div> : <div className="h-56 rounded-2xl border border-hair bg-sf animate-pulse-soft" />;
  }

  const remote = /^(https?|ssh):\/\/|^[\w.-]+@[\w.-]+:/.test(draft.repository);
  const ssh = /^ssh:\/\/|^[\w.-]+@[\w.-]+:/.test(draft.repository);
  return (
    <div className="space-y-4">
      <Card className="px-5 py-4">
        <div className="mb-3 flex items-center gap-2">
          <GitBranch className="size-4 text-t3" strokeWidth={1.8} />
          <SectionLabel>Repository</SectionLabel>
          <span className="ml-auto">{view.configured ? <Badge tone="success">Connected</Badge> : <Badge tone="muted">Not connected</Badge>}</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <FieldLabel>Repository</FieldLabel>
            <Input value={draft.repository} onChange={(e) => set('repository', e.target.value)} placeholder="https://github.com/acme/workflows.git or /srv/git/workflows.git" spellCheck={false} />
          </div>
          <div>
            <FieldLabel>Branch</FieldLabel>
            <Input value={draft.branch} onChange={(e) => set('branch', e.target.value)} spellCheck={false} />
          </div>
          <div>
            <FieldLabel>Directory in the repository</FieldLabel>
            <Input value={draft.directory} onChange={(e) => set('directory', e.target.value)} placeholder="(the root)" spellCheck={false} />
          </div>
          {ssh && (
            <>
              <div className="sm:col-span-2">
                <FieldLabel>SSH key</FieldLabel>
                <Select value={draft.sshCredentialId} onChange={(e) => set('sshCredentialId', e.target.value)}>
                  <option value="">The host account’s SSH keys</option>
                  {creds
                    .filter((c) => c.type === 'core.sshPrivateKey')
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </Select>
                <p className="mt-1 text-[12px] text-t3">A key from an “SSH private key” credential is used alone: no agent, no agent forwarding, and only the host keys pinned below.</p>
              </div>
              {draft.sshCredentialId && (
                <div className="sm:col-span-2">
                  <div className="mb-1 flex items-center gap-2">
                    <FieldLabel>Pinned host keys (known_hosts)</FieldLabel>
                    <Button size="sm" variant="outline" className="ml-auto" onClick={fetchHostKeys} loading={busy === 'hostkeys'}>
                      Fetch host key
                    </Button>
                  </div>
                  <Textarea value={draft.knownHosts} onChange={(e) => set('knownHosts', e.target.value)} rows={3} spellCheck={false} className="font-mono text-[12px]" placeholder="[git.example.com]:22 ssh-ed25519 AAAA…" />
                  {scan && (
                    <div className="mt-2 rounded-[10px] border border-hair px-3 py-2 text-[12px] text-t2">
                      <p className="mb-1 text-t1">
                        {scan.host}:{scan.port} presents these keys. Compare the fingerprints with the ones the server’s owner publishes, then pin them:
                      </p>
                      <ul className="font-mono">
                        {scan.keys.map((k) => (
                          <li key={k.line}>
                            {k.type} {k.fingerprint}
                          </li>
                        ))}
                      </ul>
                      <Button
                        size="sm"
                        className="mt-2"
                        onClick={() => {
                          set('knownHosts', scan.knownHosts);
                          setScan(undefined);
                        }}
                      >
                        Pin these keys
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {remote && !ssh && (
            <>
              <div>
                <FieldLabel>Token (HTTPS)</FieldLabel>
                <Select value={draft.credentialId} onChange={(e) => set('credentialId', e.target.value)}>
                  <option value="">{view.tokenSource === 'env' && !draft.credentialId ? 'LANDFLOW_GIT_TOKEN (environment)' : 'None, or LANDFLOW_GIT_TOKEN'}</option>
                  {creds.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <FieldLabel>User name sent with the token</FieldLabel>
                <Input value={draft.username} onChange={(e) => set('username', e.target.value)} spellCheck={false} />
              </div>
            </>
          )}
          <div>
            <FieldLabel>Commit author</FieldLabel>
            <Input value={draft.authorName} onChange={(e) => set('authorName', e.target.value)} />
          </div>
          <div>
            <FieldLabel>Author email</FieldLabel>
            <Input value={draft.authorEmail} onChange={(e) => set('authorEmail', e.target.value)} spellCheck={false} />
          </div>
          <div className="flex items-center gap-2 sm:col-span-2">
            <Switch checked={draft.includeVariableValues} onChange={(v) => set('includeVariableValues', v)} label="Commit variable values" />
            <span className="text-[13px] text-t2">Commit variable values (by default variables.json holds names only)</span>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <Button variant="primary" onClick={save} loading={busy === 'save'} disabled={!dirty || !draft.repository.trim()}>
            <Save className="size-3.5" /> Save
          </Button>
          {view.configured && (
            <Button variant="ghost" onClick={disconnect} loading={busy === 'disconnect'} className="ml-auto">
              <Unplug className="size-3.5" /> Disconnect
            </Button>
          )}
        </div>
      </Card>

      {view.configured && (
        <Card className="px-5 py-4">
          <div className="mb-3 flex items-center gap-2">
            <SectionLabel>Push and pull</SectionLabel>
            <span className="ml-auto text-[12px] text-t3">
              Last push {when(view.lastPush?.at)}
              {view.lastPush?.commit && ` (${view.lastPush.commit.slice(0, 7)})`} · last pull {when(view.lastPull?.at)}
              {view.lastPull?.commit && ` (${view.lastPull.commit.slice(0, 7)})`}
            </span>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[240px] flex-1">
              <FieldLabel>Commit message</FieldLabel>
              <Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Update from Landflow" />
            </div>
            <Button variant="primary" onClick={push} loading={busy === 'push'} disabled={onlyPicked && !picked.length}>
              <ArrowUpFromLine className="size-3.5" /> {onlyPicked ? `Push ${plural(picked.length, 'workflow')}` : 'Push'}
            </Button>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Switch checked={onlyPicked} onChange={setOnlyPicked} label="Only some workflows" />
            <span className="text-[13px] text-t2">Commit only the workflows picked below (and their folders); the rest of the branch stays as it is</span>
          </div>
          {onlyPicked && (
            <div className="mt-2 max-h-48 overflow-y-auto rounded-[10px] border border-hair px-3 py-1.5">
              {workflows.length === 0 && <p className="py-1 text-[13px] text-t3">No workflows.</p>}
              {workflows.map((w) => (
                <label key={w.id} className="flex items-center gap-2 py-0.5 text-[13px] text-t1">
                  <input type="checkbox" checked={picked.includes(w.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, w.id] : p.filter((id) => id !== w.id)))} />
                  <span className="truncate">{w.name}</span>
                </label>
              ))}
            </div>
          )}
          {lastPush && lastPush.files.length > 0 && (
            <ul className="mt-2 space-y-0.5 font-mono text-[12px] text-t2">
              {lastPush.files.map((f) => (
                <li key={f.path}>
                  {f.status} {f.path}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-hair pt-4">
            <Switch checked={prune} onChange={setPrune} label="Delete missing" />
            <span className="text-[13px] text-t2">Delete workflows, folders and variables the branch doesn’t have</span>
            <span className="ml-auto flex gap-2">
              <Button onClick={() => pull(true)} loading={busy === 'preview'}>
                Preview pull
              </Button>
              <Button variant="primary" onClick={() => pull(false)} loading={busy === 'pull'}>
                <ArrowDownToLine className="size-3.5" /> Pull
              </Button>
            </span>
          </div>
          {preview && (
            <div className="mt-3 rounded-[10px] border border-hair px-3 py-2">
              <div className="mb-1 flex items-center gap-2 text-[12px] text-t3">
                {preview.commit && <span>From {preview.commit.slice(0, 7)} on {preview.branch}</span>}
                {preview.conflicts > 0 && (
                  <span className="flex items-center gap-1 text-rd">
                    <TriangleAlert className="size-3" /> {plural(preview.conflicts, 'conflict')} with edits made here since the last sync
                  </span>
                )}
              </div>
              <Changes changes={preview.changes} />
              {[...preview.errors, ...preview.warnings].map((w) => (
                <p key={w} className="mt-1 text-[12px] text-t3">
                  {w}
                </p>
              ))}
              {preview.conflicts > 0 && (
                <Button variant="danger" size="sm" className="mt-2" onClick={() => pull(false, true)} loading={busy === 'pull'}>
                  Pull anyway, overwriting the edits made here
                </Button>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
