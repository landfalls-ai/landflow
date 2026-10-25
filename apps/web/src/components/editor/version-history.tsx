'use client';
/**
 * Version history: every save is a version (lib/server/versions.ts). The list
 * shows when, how many nodes and what changed against the version before; the
 * selected version is previewed on a read-only canvas, and Restore saves it as
 * a new version (the current state stays in the history). The published version
 * (what production triggers run) is marked; publishing an older one rolls back.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { History, Loader2, Rocket, RotateCcw, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { VersionDiff, Workflow, WorkflowVersion, WorkflowVersionSummary } from '@/lib/shared/types';
import { ExecutionCanvas } from '../executions/execution-canvas';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { SectionLabel } from '../ui/inputs';
import { publishVersion, toastApprovalRequested } from './publish-control';
import { useEditor } from './store';

export const useVersionHistory = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({ open: false, setOpen: (open) => set({ open }) }));

const NO_RUN_DATA = {};

function stamp(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function DiffDetail({ diff }: { diff: VersionDiff }) {
  const rows: Array<[string, string[], string]> = [
    ['Added', diff.nodesAdded, 'text-gn'],
    ['Removed', diff.nodesRemoved, 'text-rd'],
    ['Changed', diff.nodesChanged, 'text-t1'],
    ['Moved', diff.nodesMoved, 'text-t3'],
  ];
  const other = [
    diff.connectionsAdded && `${diff.connectionsAdded} connection${diff.connectionsAdded === 1 ? '' : 's'} added`,
    diff.connectionsRemoved && `${diff.connectionsRemoved} connection${diff.connectionsRemoved === 1 ? '' : 's'} removed`,
    diff.settingsChanged && 'settings changed',
    diff.stickiesChanged && 'sticky notes changed',
    diff.groupsChanged && 'groups changed',
  ].filter(Boolean);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
      {rows
        .filter(([, names]) => names.length)
        .map(([label, names, tone]) => (
          <span key={label} className="min-w-0 truncate" title={names.join(', ')}>
            <span className="text-t3">{label}:</span> <span className={tone}>{names.slice(0, 4).join(', ')}{names.length > 4 ? ` +${names.length - 4}` : ''}</span>
          </span>
        ))}
      {other.length > 0 && <span className="text-t3">{other.join(' · ')}</span>}
    </div>
  );
}

export function VersionHistory({ onSave }: { onSave: () => Promise<boolean> }) {
  const open = useVersionHistory((s) => s.open);
  const workflowId = useEditor((s) => s.workflowId);
  const dirty = useEditor((s) => s.dirty);
  const nodeTypes = useEditor((s) => s.nodeTypes);
  const [versions, setVersions] = useState<WorkflowVersionSummary[]>();
  const [selectedId, setSelectedId] = useState<string>();
  const [version, setVersion] = useState<WorkflowVersion>();
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [publishedId, setPublishedId] = useState<string>();
  const [publishing, setPublishing] = useState<'confirm' | 'busy'>();
  const [error, setError] = useState<string>();
  const close = useCallback(() => useVersionHistory.getState().setOpen(false), []);

  const loadList = useCallback(async () => {
    try {
      const { versions: list, publishedVersionId } = await api<{ versions: WorkflowVersionSummary[]; publishedVersionId?: string }>(`/api/workflows/${workflowId}/versions`);
      setVersions(list);
      setPublishedId(publishedVersionId);
      setError(undefined);
      return list;
    } catch (e) {
      setError((e as Error).message);
      setVersions([]);
      return [];
    }
  }, [workflowId]);

  useEffect(() => {
    if (!open) return;
    setConfirming(false);
    void loadList().then((list) => setSelectedId(list[0]?.id));
  }, [open, loadList]);

  useEffect(() => {
    if (!open || !selectedId) return setVersion(undefined);
    let cancelled = false;
    setConfirming(false);
    setPublishing(undefined);
    api<{ version: WorkflowVersion }>(`/api/workflows/${workflowId}/versions/${selectedId}`)
      .then(({ version: v }) => !cancelled && setVersion(v))
      .catch((e: Error) => !cancelled && toast.error(`Could not load the version: ${e.message}`));
    return () => {
      cancelled = true;
    };
  }, [open, selectedId, workflowId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('[role="dialog"]')) return;
      if (confirming) setConfirming(false);
      else close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, confirming, close]);

  const restore = async () => {
    if (!version) return;
    setRestoring(true);
    try {
      // Unsaved edits become a version first, so restoring never loses them.
      if (useEditor.getState().dirty && !(await onSave())) return;
      const { workflow } = await api<{ workflow: Workflow }>(`/api/workflows/${workflowId}/versions/${version.id}/restore`, { method: 'POST' });
      useEditor.getState().load(workflow, Object.values(useEditor.getState().nodeTypes));
      toast.success(`Restored version ${version.number}`, { description: 'Saved as a new version' });
      const list = await loadList();
      setSelectedId(list[0]?.id);
      setConfirming(false);
    } catch (e) {
      toast.error(`Restore failed: ${(e as Error).message}`);
    } finally {
      setRestoring(false);
    }
  };

  /** Publish the selected version: production triggers run it from now on (a rollback when it is older). */
  const publishSelected = async () => {
    if (!version) return;
    setPublishing('busy');
    try {
      const result = await publishVersion(workflowId, { versionId: version.id, note: version.id === newestId ? undefined : `Rolled back to version ${version.number}` });
      if (result.approvalRequired) return toastApprovalRequested(result);
      setPublishedId(result.published?.versionId);
      toast.success(`Published version ${version.number}`, { description: 'Production triggers run this version now' });
    } catch (e) {
      toast.error(`Publish failed: ${(e as Error).message}`);
    } finally {
      setPublishing(undefined);
    }
  };

  const newestId = versions?.[0]?.id;
  const preview = useMemo(() => version?.workflow, [version]);
  if (!open) return null;
  const isCurrent = version?.id === newestId && !dirty;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-overlay p-6" onMouseDown={close}>
      <div
        role="region"
        aria-label="Version history"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex h-full max-h-[820px] w-full max-w-[1320px] animate-in overflow-hidden rounded-2xl border border-hair bg-sf shadow-pop"
      >
        {/* list */}
        <div className="flex w-[330px] shrink-0 flex-col border-r border-hair bg-sf2">
          <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-hair px-4">
            <History className="size-4 text-t2" />
            <span className="text-[14px] font-semibold text-t1">Version history</span>
            {versions && <span className="text-[12px] text-t3">{versions.length}</span>}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {!versions && (
              <div className="grid h-32 place-items-center">
                <Loader2 className="size-4 animate-spin text-t3" />
              </div>
            )}
            {versions?.length === 0 && (
              <EmptyState title="No versions yet" hint={error ?? 'Every save creates a version. Save this workflow to start its history.'} />
            )}
            {versions?.map((v, i) => (
              <button
                key={v.id}
                onClick={() => setSelectedId(v.id)}
                className={cn(
                  'mb-1 flex w-full flex-col gap-1 rounded-xl border px-3 py-2.5 text-left transition-colors',
                  v.id === selectedId ? 'border-bd bg-sf shadow-[0_1px_3px_var(--hair)]' : 'border-transparent hover:bg-acdim',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-t1">Version {v.number}</span>
                  {i === 0 && <Badge tone={dirty ? 'muted' : 'success'}>{dirty ? 'last saved' : 'current'}</Badge>}
                  {v.restoredFrom && <Badge tone="neutral">restored</Badge>}
                  {v.id === publishedId && (
                    <Badge tone="accent" title="Production triggers run this version">
                      published
                    </Badge>
                  )}
                  <span className="ml-auto shrink-0 text-[11px] text-t3" title={new Date(v.createdAt).toLocaleString()}>
                    {timeAgo(v.createdAt)}
                  </span>
                </div>
                <div className="line-clamp-2 text-[12px] leading-snug text-t2">{v.summary}</div>
                <div className="text-[11px] text-t3">
                  {stamp(v.createdAt)} · {v.nodeCount} node{v.nodeCount === 1 ? '' : 's'}
                </div>
              </button>
            ))}
          </div>
          <div className="shrink-0 border-t border-hair px-4 py-2.5 text-[11px] leading-snug text-t3">The newest 50 versions are kept. Saves that change nothing add no version.</div>
        </div>

        {/* preview */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-[52px] shrink-0 items-center gap-3 border-b border-hair px-4 py-2">
            {version ? (
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[14px] font-semibold text-t1">
                    Version {version.number} · {version.name}
                  </span>
                  {version.restoredFrom && <span className="shrink-0 text-[12px] text-t3">restored from version {version.restoredFrom.number}</span>}
                </div>
                {version.diff ? <DiffDetail diff={version.diff} /> : <div className="text-[12px] text-t3">{version.summary}</div>}
              </div>
            ) : (
              <div className="flex-1 text-[13px] text-t3">{versions?.length ? 'Loading…' : ''}</div>
            )}
            {version &&
              !confirming &&
              (publishing === 'confirm' || publishing === 'busy' ? (
                <div className="flex shrink-0 animate-in items-center gap-2 rounded-full border border-acbd bg-acdim py-1 pl-3 pr-1">
                  <span className="text-[12px] text-t1">Publish version {version.number}? Production triggers switch to it.</span>
                  <Button size="sm" variant="ghost" onClick={() => setPublishing(undefined)}>
                    Cancel
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => void publishSelected()} loading={publishing === 'busy'}>
                    <Rocket className="size-3.5" /> Publish
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPublishing('confirm')}
                  disabled={version.id === publishedId}
                  title={version.id === publishedId ? 'This version is published' : 'Production triggers run this version (a rollback for an older one)'}
                >
                  <Rocket className="size-3.5" /> {version.id === publishedId ? 'Published' : 'Publish this version'}
                </Button>
              ))}
            {version &&
              !publishing &&
              (confirming ? (
                <div className="flex shrink-0 animate-in items-center gap-2 rounded-full border border-warnbd bg-warndim py-1 pl-3 pr-1">
                  <span className="text-[12px] text-t1">
                    {dirty ? 'Save your changes, then restore' : 'Restore'} version {version.number}?
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => void restore()} loading={restoring}>
                    <RotateCcw className="size-3.5" /> Restore
                  </Button>
                </div>
              ) : (
                <Button size="sm" onClick={() => setConfirming(true)} disabled={isCurrent} title={isCurrent ? 'This is the current version' : 'Make this the current version'}>
                  <RotateCcw className="size-3.5" /> Restore this version
                </Button>
              ))}
            <Button variant="ghost" size="icon-sm" onClick={close} aria-label="Close version history">
              <X className="size-4" />
            </Button>
          </div>
          <div className="relative min-h-0 flex-1">
            {preview ? (
              <ExecutionCanvas key={version?.id} workflow={preview} nodeTypes={nodeTypes} runData={NO_RUN_DATA} />
            ) : (
              <div className="canvas-readonly grid size-full place-items-center bg-[repeating-linear-gradient(-45deg,transparent_0_14px,var(--acdim)_14px_28px)]">
                {selectedId && <Loader2 className="size-5 animate-spin text-t3" />}
              </div>
            )}
            {preview && (
              <div className="pointer-events-none absolute left-3 top-3 rounded-full border border-hair bg-sf/90 px-2.5 py-1 text-[11px] text-t3 backdrop-blur">
                <SectionLabel className="inline">Read-only preview</SectionLabel>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
