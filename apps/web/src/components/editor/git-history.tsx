'use client';
/**
 * "Git history" from the editor's … menu: the commits of the source control branch that touched this workflow's file
 * (Settings → Source control), the diff of each, Restore (saves that version as a new draft; nothing is published) and
 * "Commit and push" for this workflow alone.
 */
import { useCallback, useEffect, useState } from 'react';
import { ArrowUpFromLine, GitCommitHorizontal, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { Workflow } from '@/lib/shared/types';
import type { GitCommitDetail, GitHistory, SourceControlPushResult } from '@/lib/shared/sync';
import { Dialog } from '@/components/agents/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/inputs';
import { cn } from '@/lib/utils';
import { useEditor } from './store';

export function GitHistoryDialog({ workflowId, onClose }: { workflowId: string; onClose: () => void }) {
  const [history, setHistory] = useState<GitHistory>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<GitCommitDetail>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<'push' | 'restore'>();

  const load = useCallback(async () => {
    try {
      setHistory(await api<GitHistory>(`/api/workflows/${workflowId}/git-history`));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [workflowId]);
  useEffect(() => {
    void load();
  }, [load]);

  const open = async (commit: string, path: string) => {
    try {
      setSelected(await api<GitCommitDetail>(`/api/workflows/${workflowId}/git-history/${commit}?path=${encodeURIComponent(path)}`));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const push = async () => {
    setBusy('push');
    try {
      const result = await api<SourceControlPushResult>('/api/source-control/push', { method: 'POST', json: { workflowIds: [workflowId], message: message.trim() || undefined } });
      toast.success(result.committed ? `Pushed ${result.commit?.slice(0, 7)}` : 'Nothing to commit: the branch has this workflow as it is');
      setMessage('');
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const restore = async () => {
    if (!selected) return;
    setBusy('restore');
    try {
      const { workflow } = await api<{ workflow: Workflow }>(`/api/workflows/${workflowId}/git-history/${selected.commit}/restore`, { method: 'POST', json: { path: selected.path } });
      useEditor.getState().load(workflow, Object.values(useEditor.getState().nodeTypes));
      toast.success(`Restored from ${selected.shortCommit}`, { description: 'Saved as a new draft; nothing is published' });
      onClose();
    } catch (e) {
      toast.error(`Restore failed: ${(e as Error).message}`);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Dialog title="Git history" subtitle={history?.path ?? 'Commits that touched this workflow’s file'} icon={<GitCommitHorizontal className="size-5 text-t2" />} onClose={onClose} width={860}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Commit message (optional)" className="flex-1" />
          <Button variant="primary" onClick={() => void push()} loading={busy === 'push'}>
            <ArrowUpFromLine className="size-3.5" /> Commit and push this workflow
          </Button>
        </div>
        {error && <p className="text-[13px] text-rd">{error}</p>}
        {history?.branchMissing && <p className="text-[13px] text-t2">The branch isn’t in the repository yet: push first.</p>}
        {history && !history.branchMissing && history.commits.length === 0 && <p className="text-[13px] text-t2">No commit has this workflow yet.</p>}
        <div className="grid min-h-[260px] gap-3 sm:grid-cols-[300px_1fr]">
          <ul className="max-h-[420px] overflow-y-auto">
            {history?.commits.map((c) => (
              <li key={c.commit}>
                <button onClick={() => void open(c.commit, c.path)} className={cn('mb-1 w-full rounded-lg border px-3 py-2 text-left', selected?.commit === c.commit ? 'border-bd bg-sf' : 'border-transparent hover:bg-acdim')}>
                  <div className="truncate text-[13px] text-t1">{c.subject}</div>
                  <div className="text-[11px] text-t3">
                    {c.shortCommit} · {c.author} · {timeAgo(c.at)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <div className="min-w-0">
            {selected ? (
              <>
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-t1">{selected.shortCommit}</span>
                  <span className="min-w-0 truncate text-[12px] text-t3">{selected.subject}</span>
                  {selected.workflow && (
                    <Button size="sm" className="ml-auto" onClick={() => void restore()} loading={busy === 'restore'} title="Save this version as a new draft">
                      <RotateCcw className="size-3.5" /> Restore as draft
                    </Button>
                  )}
                </div>
                <pre className="max-h-[380px] overflow-auto rounded-lg border border-hair bg-sf2 p-2 font-mono text-[11px] leading-snug">
                  {selected.diff.split('\n').map((line, i) => (
                    <div key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'text-gn' : line.startsWith('-') && !line.startsWith('---') ? 'text-rd' : 'text-t2'}>
                      {line || ' '}
                    </div>
                  ))}
                </pre>
              </>
            ) : (
              <p className="text-[13px] text-t3">Pick a commit to see what it changed.</p>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
