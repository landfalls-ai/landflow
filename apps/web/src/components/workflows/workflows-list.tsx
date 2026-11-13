'use client';
/**
 * The workflows list: folders with a breadcrumb (open with `?folder=<id>`),
 * search by name, a tag filter and sorting. Searching or filtering looks in
 * every folder and shows where each match lives. Workflows move to folders
 * from their menu or by dragging them onto a folder or a breadcrumb step;
 * folders belong to a project (`?project=<id>` shows one project's folders and workflows, and creates there; a
 * workflow only goes into a folder of its own project);
 * Import creates a workflow from a Landflow, n8n or Flowise JSON file. In a protected environment (workflows
 * read-only, the API refuses changes) the buttons that create, move or delete are disabled with the reason.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRightLeft, ChevronRight, Download, ExternalLink, FileUp, Folder as FolderIcon, FolderInput, FolderPlus, LayoutTemplate, Lock, MoreHorizontal, Pencil, Plus, Share2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/client/api';
import { useWorkflowsReadOnly } from '@/lib/client/environment';
import { timeAgo } from '@/lib/client/format';
import { nodeColor, tint } from '@/lib/client/node-style';
import { resourceCan, type ResourceOwnership } from '@/lib/shared/projects';
import type { Folder, ImportReport, NodeTypeInfo, Workflow, WorkflowSummary as Summary } from '@/lib/shared/types';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { ProtectedGate } from '@/components/shell/protected-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { NodeIcon } from '@/components/ui/icon';
import { SearchInput, Select } from '@/components/ui/inputs';
import { MenuItem, MenuSeparator, Popover } from '@/components/ui/popover';
import { ImportReportDialog, showImportReport } from '@/components/editor/import-report';
import { readJsonFile } from '@/components/editor/import-dialog';
import { workflowFileName } from '@/components/editor/workflow-menu';
import { rememberProject } from '@/components/projects/current-project';
import { MoveToProjectDialog, ShareDialog } from '@/components/projects/share-dialog';
import { projectLabel, useProjects } from '@/components/projects/use-projects';
import { useViewer } from '@/components/auth/viewer';
import { FolderNameDialog, MoveDialog } from './folder-dialogs';

/** A listed workflow with its project and the viewer's access (GET /api/workflows). */
type WorkflowSummary = Summary & { ownership?: ResourceOwnership };

const MAX_ICONS = 6;
const SORT_KEY = 'landflow-workflows-sort';
const DRAG_TYPE = 'application/x-landflow-workflow';

type Sort = 'updated' | 'name' | 'created';
const SORTS: Record<Sort, { label: string; compare: (a: WorkflowSummary, b: WorkflowSummary) => number }> = {
  updated: { label: 'Last updated', compare: (a, b) => b.updatedAt.localeCompare(a.updatedAt) },
  name: { label: 'Name', compare: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) },
  created: { label: 'Created', compare: (a, b) => b.createdAt.localeCompare(a.createdAt) },
};

function readSort(): Sort {
  try {
    const value = localStorage.getItem(SORT_KEY);
    return value === 'name' || value === 'created' ? value : 'updated';
  } catch {
    return 'updated';
  }
}

/** Accepts a dragged workflow: highlights while it is over, then moves it to `folderId` (null = top level). Off when `off` (read-only). */
function useDropTarget(folderId: string | null, onDrop: (workflowId: string, folderId: string | null) => void, off?: boolean) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => {
        if (off || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        setOver(false);
        const id = e.dataTransfer.getData(DRAG_TYPE);
        if (!id || off) return;
        e.preventDefault();
        onDrop(id, folderId);
      },
    },
  };
}

function Crumb({
  folder,
  last,
  onOpen,
  onDropWorkflow,
  readOnly,
  rootLabel = 'All workflows',
}: {
  folder?: Folder;
  last: boolean;
  onOpen: () => void;
  onDropWorkflow: (id: string, folderId: string | null) => void;
  readOnly?: string;
  rootLabel?: string;
}) {
  const drop = useDropTarget(folder?.id ?? null, onDropWorkflow, Boolean(readOnly));
  return (
    <button
      {...drop.props}
      onClick={onOpen}
      disabled={last}
      className={cn(
        'max-w-[220px] truncate rounded-md px-1.5 py-0.5 transition-colors',
        last ? 'font-semibold text-t1' : 'text-t2 hover:bg-acdim hover:text-t1',
        drop.over && 'bg-acdim text-t1 shadow-[0_0_0_2px_var(--ac)]',
      )}
    >
      {folder?.name ?? rootLabel}
    </button>
  );
}

function FolderRow({
  folder,
  counts,
  projectName,
  onOpen,
  onRename,
  onDelete,
  onDropWorkflow,
  readOnly,
}: {
  folder: Folder;
  counts: { folders: number; workflows: number };
  /** Shown when the list spans projects. */
  projectName?: string;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
  onDropWorkflow: (id: string, folderId: string | null) => void;
  /** Why folders can't change here (a protected environment). */
  readOnly?: string;
}) {
  const drop = useDropTarget(folder.id, onDropWorkflow, Boolean(readOnly));
  const empty = !counts.folders && !counts.workflows;
  const [confirming, setConfirming] = useState(false);
  return (
    <div
      {...drop.props}
      className={cn(
        'group flex items-center rounded-2xl border border-hair bg-sf transition-colors duration-[120ms] hover:border-bd',
        drop.over && 'border-ac bg-acdim shadow-[0_0_0_1px_var(--ac)]',
      )}
    >
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 py-3 pl-4 text-left">
        <span className="grid size-8 shrink-0 place-items-center rounded-[10px] border border-hair bg-wl text-t2">
          <FolderIcon className="size-4" strokeWidth={1.7} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-t1">{folder.name}</span>
          <span className="block text-[12px] text-t3">
            {empty
              ? 'Empty'
              : [counts.folders && `${counts.folders} folder${counts.folders === 1 ? '' : 's'}`, counts.workflows && `${counts.workflows} workflow${counts.workflows === 1 ? '' : 's'}`]
                  .filter(Boolean)
                  .join(' · ')}
          </span>
        </span>
        {projectName && (
          <Badge tone="muted" className="mr-1 hidden shrink-0 sm:inline-flex" title="The project this folder belongs to">
            {projectName}
          </Badge>
        )}
      </button>
      <div className="pl-2 pr-2.5">
        <Popover
          trigger={({ open, toggle }) => (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                setConfirming(false);
                toggle();
              }}
              aria-label={`Folder ${folder.name} menu`}
              className={cn('text-t3 opacity-0 focus-visible:opacity-100 group-hover:opacity-100', open && 'opacity-100')}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          )}
        >
          {(close) =>
            confirming ? (
              <div className="w-[230px] space-y-2 p-1.5">
                <p className="text-[12px] text-t1">Delete the folder “{folder.name}”?</p>
                <div className="flex justify-end gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      close();
                      onDelete();
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <MenuItem
                  onClick={() => {
                    close();
                    onOpen();
                  }}
                >
                  <FolderIcon /> Open
                </MenuItem>
                <MenuItem
                  disabled={Boolean(readOnly)}
                  hint={readOnly && 'read-only'}
                  onClick={() => {
                    close();
                    onRename();
                  }}
                >
                  <Pencil /> Rename
                </MenuItem>
                <MenuSeparator />
                <MenuItem danger disabled={!empty || Boolean(readOnly)} onClick={() => setConfirming(true)} hint={readOnly ? 'read-only' : empty ? undefined : 'not empty'}>
                  <Trash2 /> Delete folder
                </MenuItem>
              </>
            )
          }
        </Popover>
      </div>
    </div>
  );
}

function WorkflowRow({
  workflow,
  types,
  folderPath,
  onMove,
  onShare,
  onTransfer,
  onDelete,
  readOnly,
}: {
  workflow: WorkflowSummary;
  types: Record<string, NodeTypeInfo>;
  /** Shown when the list spans folders (search, tag filter). */
  folderPath?: string;
  onMove: () => void;
  onShare: () => void;
  onTransfer: () => void;
  onDelete: () => void;
  /** Why workflows can't move or be deleted here (a protected environment). */
  readOnly?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const download = async () => {
    try {
      const { workflow: full } = await api<{ workflow: Workflow }>(`/api/workflows/${workflow.id}`);
      const { id: _id, active: _active, createdAt: _c, updatedAt: _u, folderId: _f, ...rest } = full;
      const url = URL.createObjectURL(new Blob([JSON.stringify({ ...rest, meta: { exportedFrom: 'landflow', exportedAt: new Date().toISOString() } }, null, 2)], { type: 'application/json' }));
      const link = Object.assign(document.createElement('a'), { href: url, download: workflowFileName(full.name) });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <div
      draggable={!readOnly}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, workflow.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      className="group flex items-center rounded-2xl border border-hair bg-sf transition-colors duration-[120ms] hover:border-bd"
    >
      <Link href={`/workflows/${workflow.id}`} draggable={false} className="flex min-w-0 flex-1 items-center gap-4 py-3 pl-4">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-t1">{workflow.name}</span>
            {folderPath && (
              <span className="flex shrink-0 items-center gap-1 text-[11px] text-t3">
                <FolderIcon className="size-3" /> {folderPath}
              </span>
            )}
          </div>
          <div className="mt-1.5 flex min-w-0 items-center gap-2.5">
            {workflow.nodeTypes.length > 0 && (
              <div className="flex shrink-0 items-center gap-1">
                {workflow.nodeTypes.slice(0, MAX_ICONS).map((type) => {
                  const info = types[type];
                  const color = nodeColor(info);
                  return (
                    <span
                      key={type}
                      title={info?.descriptor.displayName ?? type}
                      className="grid size-6 place-items-center rounded-lg border border-hair transition-transform duration-150 group-hover:scale-105"
                      style={{ background: tint(color, 12) }}
                    >
                      <NodeIcon icon={info?.descriptor.icon} size={13} strokeWidth={1.9} style={{ color }} />
                    </span>
                  );
                })}
                {workflow.nodeTypes.length > MAX_ICONS && <span className="pl-0.5 text-[12px] text-t3">+{workflow.nodeTypes.length - MAX_ICONS}</span>}
              </div>
            )}
            <span className="truncate text-[12px] text-t3">{workflow.description || 'No description'}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {workflow.tags.map((tag) => (
            <Badge key={tag} tone="neutral" className="hidden md:inline-flex">
              {tag}
            </Badge>
          ))}
          {workflow.ownership?.shared && <Badge tone="muted" title={`Shared from ${workflow.ownership.projectName}`}>{workflow.ownership.access.role === 'viewer' ? 'Shared · view' : 'Shared'}</Badge>}
          {workflow.active && <Badge tone="success">Published</Badge>}
          <span className="hidden w-16 text-right text-[12px] text-t3 sm:inline">
            {workflow.nodeCount} {workflow.nodeCount === 1 ? 'node' : 'nodes'}
          </span>
          <span className="w-16 text-right text-[12px] tabular-nums text-t2" title={`Updated ${new Date(workflow.updatedAt).toLocaleString()}`}>
            {timeAgo(workflow.updatedAt)}
          </span>
        </div>
      </Link>
      <div className="pl-2 pr-2.5">
        <Popover
          trigger={({ open, toggle }) => (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                setConfirming(false);
                toggle();
              }}
              aria-label={`${workflow.name} menu`}
              className={cn('text-t3 opacity-0 focus-visible:opacity-100 group-hover:opacity-100', open && 'opacity-100')}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          )}
        >
          {(close) =>
            confirming ? (
              <div className="w-[240px] space-y-2 p-1.5">
                <p className="text-[12px] text-t1">Delete “{workflow.name}” and its version history?</p>
                <div className="flex justify-end gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      close();
                      onDelete();
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <Link href={`/workflows/${workflow.id}`} className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-t1 hover:bg-acdim [&_svg]:size-3.5">
                  <ExternalLink /> Open
                </Link>
                <MenuItem
                  disabled={Boolean(readOnly)}
                  hint={readOnly && 'read-only'}
                  onClick={() => {
                    close();
                    onMove();
                  }}
                >
                  <FolderInput /> Move to folder…
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    close();
                    onShare();
                  }}
                >
                  <Share2 /> {resourceCan(workflow.ownership?.access, 'share') || !workflow.ownership ? 'Share…' : 'Who has access…'}
                </MenuItem>
                {(!workflow.ownership || resourceCan(workflow.ownership.access, 'move')) && (
                  <MenuItem
                    onClick={() => {
                      close();
                      onTransfer();
                    }}
                  >
                    <ArrowRightLeft /> Move to project…
                  </MenuItem>
                )}
                <MenuItem
                  onClick={() => {
                    close();
                    void download();
                  }}
                >
                  <Download /> Download JSON
                </MenuItem>
                <MenuSeparator />
                <MenuItem danger disabled={Boolean(readOnly)} hint={readOnly && 'read-only'} onClick={() => setConfirming(true)}>
                  <Trash2 /> Delete
                </MenuItem>
              </>
            )
          }
        </Popover>
      </div>
    </div>
  );
}

export function WorkflowsList() {
  const router = useRouter();
  const params = useSearchParams();
  const viewer = useViewer();
  const { projects } = useProjects();
  const folderId = params.get('folder') ?? undefined;
  const projectId = params.get('project') ?? undefined;
  const project = projects?.find((p) => p.id === projectId);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [types, setTypes] = useState<Record<string, NodeTypeInfo>>({});
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [sort, setSortState] = useState<Sort>('updated');
  const [dialog, setDialog] = useState<{ kind: 'new-folder' } | { kind: 'rename'; folder: Folder } | { kind: 'move' | 'share' | 'transfer'; workflow: WorkflowSummary }>();
  const picker = useRef<HTMLInputElement>(null);
  // A protected environment: workflows and folders are read-only here (the API refuses changes).
  const readOnly = useWorkflowsReadOnly();
  const locked = Boolean(readOnly);

  const scopeQuery = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  const load = useCallback(
    () =>
      Promise.all([api<{ workflows: WorkflowSummary[] }>(`/api/workflows${scopeQuery}`), api<{ folders: Folder[] }>(`/api/folders${scopeQuery}`).catch(() => ({ folders: [] as Folder[] }))]).then(([w, f]) => {
        setWorkflows(w.workflows);
        setFolders(f.folders);
      }),
    [scopeQuery],
  );
  useEffect(() => {
    void load();
    setSortState(readSort());
    api<{ nodeTypes: NodeTypeInfo[] }>('/api/node-types').then((r) => setTypes(Object.fromEntries(r.nodeTypes.map((t) => [t.type, t]))));
  }, [load]);

  const setSort = (next: Sort) => {
    setSortState(next);
    try {
      localStorage.setItem(SORT_KEY, next);
    } catch {}
  };

  const byId = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const current = folderId ? byId.get(folderId) : undefined;
  const pathOf = useCallback(
    (id?: string) => {
      const path: Folder[] = [];
      for (let f = id ? byId.get(id) : undefined; f && path.length < 50; f = f.parentId ? byId.get(f.parentId) : undefined) path.unshift(f);
      return path;
    },
    [byId],
  );
  const breadcrumb = pathOf(current?.id);
  const allTags = useMemo(() => [...new Set((workflows ?? []).flatMap((w) => w.tags))].sort((a, b) => a.localeCompare(b)), [workflows]);
  const searching = query.trim() !== '' || tag !== '';
  const known = (id?: string) => (id && byId.has(id) ? id : undefined);

  const visibleWorkflows = useMemo(() => {
    if (!workflows) return undefined;
    const needle = query.trim().toLowerCase();
    const list = searching
      ? workflows.filter((w) => (!needle || w.name.toLowerCase().includes(needle)) && (!tag || w.tags.includes(tag)))
      : workflows.filter((w) => (w.folderId && byId.has(w.folderId) ? w.folderId : undefined) === current?.id);
    return [...list].sort(SORTS[sort].compare);
  }, [workflows, query, tag, sort, current?.id, searching, byId]);
  const childFolders = searching ? [] : folders.filter((f) => (known(f.parentId) ?? undefined) === current?.id).sort((a, b) => a.name.localeCompare(b.name));
  const countsOf = (id: string) => ({ folders: folders.filter((f) => f.parentId === id).length, workflows: (workflows ?? []).filter((w) => w.folderId === id).length });

  const openFolder = (id?: string, inProject = projectId) => {
    setQuery('');
    setTag('');
    const search = new URLSearchParams({ ...(inProject && { project: inProject }), ...(id && { folder: id }) }).toString();
    router.push(search ? `/workflows?${search}` : '/workflows');
  };
  const pickProject = (id: string) => {
    if (id) rememberProject(id);
    openFolder(undefined, id || undefined);
  };
  // Folders of more than one project in the list: each shows its project.
  const multiProject = new Set(folders.map((f) => f.projectId)).size > 1;
  const projectName = (id?: string) => {
    const p = projects?.find((candidate) => candidate.id === id);
    return p ? projectLabel(p, viewer?.id) : undefined;
  };

  const create = async () => {
    setCreating(true);
    try {
      // In a folder: the folder's project; else the project picked (else the caller's personal project).
      const { workflow } = await api<{ workflow: { id: string } }>(`/api/workflows${current ? '' : scopeQuery}`, {
        method: 'POST',
        json: { name: 'Untitled workflow', nodes: [], connections: [], ...(current && { folderId: current.id }) },
      });
      router.push(`/workflows/${workflow.id}`);
    } catch (e) {
      toast.error((e as Error).message);
      setCreating(false);
    }
  };

  const importFile = async (file?: File) => {
    if (!file) return;
    setImporting(true);
    try {
      const text = await readJsonFile(file);
      const { workflow, report } = await api<{ workflow: Workflow; report: ImportReport }>(`/api/workflows/import${current ? '' : scopeQuery}`, {
        method: 'POST',
        json: { data: text, create: true, ...(current && { folderId: current.id }) },
      });
      await load();
      showImportReport(report, `Imported “${workflow.name}”`, { label: 'Open workflow', onClick: () => router.push(`/workflows/${workflow.id}`) });
    } catch (e) {
      toast.error(`Import failed: ${(e as Error).message}`);
    } finally {
      setImporting(false);
      if (picker.current) picker.current.value = '';
    }
  };

  const move = async (workflowId: string, target: string | null) => {
    const workflow = workflows?.find((w) => w.id === workflowId);
    if (!workflow || (workflow.folderId ?? null) === target) return true;
    const folder = target ? byId.get(target) : undefined;
    if (folder?.projectId && workflow.ownership && folder.projectId !== workflow.ownership.projectId) {
      toast.error(`“${folder.name}” is a folder of ${projectName(folder.projectId) ? `the “${projectName(folder.projectId)}” project` : 'another project'}. Move the workflow to that project first.`);
      return false;
    }
    try {
      await api(`/api/workflows/${workflowId}/move`, { method: 'POST', json: { folderId: target } });
      toast(`Moved “${workflow.name}” to ${target ? (byId.get(target)?.name ?? 'the folder') : 'the top level'}`);
      await load();
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }
  };

  const removeWorkflow = async (workflow: WorkflowSummary) => {
    try {
      await api(`/api/workflows/${workflow.id}`, { method: 'DELETE' });
      toast(`Deleted “${workflow.name}”`);
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const removeFolder = async (folder: Folder) => {
    try {
      await api(`/api/folders/${folder.id}`, { method: 'DELETE' });
      toast(`Deleted the folder “${folder.name}”`);
      void load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not delete the folder');
    }
  };

  const count = searching ? visibleWorkflows?.length : workflows?.length;
  const loaded = workflows !== undefined;
  const emptyHere = loaded && !searching && !childFolders.length && !visibleWorkflows?.length;

  return (
    <>
      <PageHeader
        title="Workflows"
        meta={
          <>
            {count !== undefined && <span>{searching ? `${count} found` : count}</span>}
            {readOnly && (
              <span title={readOnly} className="flex items-center gap-1 text-warn" data-testid="workflows-read-only">
                <Lock className="size-3" /> Read-only
              </span>
            )}
          </>
        }
        actions={
          <>
            <ProtectedGate reason={readOnly}>
              <Button size="sm" variant="ghost" onClick={() => picker.current?.click()} loading={importing} disabled={locked} title={locked ? undefined : 'Create a workflow from a Landflow, n8n or Flowise JSON file'}>
                {!importing && <FileUp className="size-3.5" />} Import
              </Button>
            </ProtectedGate>
            <ProtectedGate reason={readOnly}>
              <Button size="sm" onClick={() => setDialog({ kind: 'new-folder' })} disabled={locked}>
                <FolderPlus className="size-3.5" /> New folder
              </Button>
            </ProtectedGate>
            <ProtectedGate reason={readOnly}>
              <Button variant="primary" size="sm" onClick={() => void create()} loading={creating} disabled={locked}>
                {!creating && <Plus className="size-3.5" strokeWidth={2} />} New workflow
              </Button>
            </ProtectedGate>
            <input ref={picker} type="file" accept=".json,application/json" className="hidden" onChange={(e) => void importFile(e.target.files?.[0] ?? undefined)} />
          </>
        }
      />
      <PageBody>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <nav aria-label="Folders" className="flex min-w-0 flex-1 items-center gap-0.5 text-[13px]">
            {searching ? (
              <span className="px-1.5 py-0.5 text-t2">
                Results in all folders
                <button onClick={() => (setQuery(''), setTag(''))} className="ml-2 text-[12px] text-t3 underline-offset-2 hover:text-t1 hover:underline">
                  clear
                </button>
              </span>
            ) : (
              <>
                <Crumb
                  last={!breadcrumb.length}
                  onOpen={() => openFolder(undefined)}
                  onDropWorkflow={(id, f) => void move(id, f)}
                  readOnly={readOnly}
                  rootLabel={project ? projectLabel(project, viewer?.id) : undefined}
                />
                {breadcrumb.map((folder, i) => (
                  <span key={folder.id} className="flex min-w-0 items-center gap-0.5">
                    <ChevronRight className="size-3.5 shrink-0 text-t3" />
                    <Crumb folder={folder} last={i === breadcrumb.length - 1} onOpen={() => openFolder(folder.id)} onDropWorkflow={(id, f) => void move(id, f)} readOnly={readOnly} />
                  </span>
                ))}
                {current && !readOnly && (
                  <button
                    onClick={() => setDialog({ kind: 'rename', folder: current })}
                    title="Rename folder"
                    aria-label="Rename folder"
                    className="ml-1 grid size-6 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1"
                  >
                    <Pencil className="size-3" />
                  </button>
                )}
              </>
            )}
          </nav>
          {(projects?.length ?? 0) > 1 && (
            <div className="w-[170px]">
              <Select value={projectId ?? ''} onChange={(e) => pickProject(e.target.value)} aria-label="Project" className="h-8 rounded-full text-[12px]">
                <option value="">All projects</option>
                {projects?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {projectLabel(p, viewer?.id)}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <SearchInput value={query} onChange={setQuery} placeholder="Search workflows" />
          <div className="w-[150px]">
            <Select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Filter by tag" className="h-8 rounded-full text-[12px]">
              <option value="">All tags</option>
              {allTags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-[150px]">
            <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort by" className="h-8 rounded-full text-[12px]">
              {(Object.keys(SORTS) as Sort[]).map((key) => (
                <option key={key} value={key}>
                  {SORTS[key].label}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          {childFolders.map((folder) => (
            <FolderRow
              key={folder.id}
              folder={folder}
              counts={countsOf(folder.id)}
              projectName={multiProject && !projectId ? projectName(folder.projectId) : undefined}
              onOpen={() => openFolder(folder.id)}
              onRename={() => setDialog({ kind: 'rename', folder })}
              onDelete={() => void removeFolder(folder)}
              onDropWorkflow={(id, f) => void move(id, f)}
              readOnly={readOnly}
            />
          ))}
          {visibleWorkflows?.map((workflow) => (
            <WorkflowRow
              key={workflow.id}
              workflow={workflow}
              types={types}
              folderPath={searching && known(workflow.folderId) ? pathOf(workflow.folderId).map((f) => f.name).join(' / ') : undefined}
              onMove={() => setDialog({ kind: 'move', workflow })}
              onShare={() => setDialog({ kind: 'share', workflow })}
              onTransfer={() => setDialog({ kind: 'transfer', workflow })}
              onDelete={() => void removeWorkflow(workflow)}
              readOnly={readOnly}
            />
          ))}
        </div>

        {loaded && searching && visibleWorkflows?.length === 0 && (
          <Card>
            <EmptyState compact title="No workflows match" hint={[query.trim() && `“${query.trim()}”`, tag && `tag ${tag}`].filter(Boolean).join(' with ')} />
          </Card>
        )}
        {emptyHere && !current && (
          <Card>
            <EmptyState
              title="No workflows yet"
              hint="Chain built-in nodes with plugins written in any language. Every node, local or remote, implements the same interface. Start from a template, or import a workflow from n8n or Flowise."
              action={
                <div className="flex gap-2">
                  <ProtectedGate reason={readOnly}>
                    <Button size="sm" onClick={() => picker.current?.click()} disabled={locked}>
                      <FileUp className="size-3.5" /> Import
                    </Button>
                  </ProtectedGate>
                  <Button size="sm" onClick={() => router.push(projectId ? `/templates?project=${encodeURIComponent(projectId)}` : '/templates')}>
                    <LayoutTemplate className="size-3.5" /> Browse templates
                  </Button>
                  <ProtectedGate reason={readOnly}>
                    <Button variant="primary" size="sm" onClick={() => void create()} loading={creating} disabled={locked}>
                      New workflow
                    </Button>
                  </ProtectedGate>
                </div>
              }
            />
          </Card>
        )}
        {emptyHere && current && (
          <Card>
            <EmptyState
              compact
              title="This folder is empty"
              hint="Create a workflow or a folder here, or drag workflows onto it from another folder."
              action={
                <div className="flex gap-2">
                  <ProtectedGate reason={readOnly}>
                    <Button size="sm" onClick={() => setDialog({ kind: 'new-folder' })} disabled={locked}>
                      <FolderPlus className="size-3.5" /> New folder
                    </Button>
                  </ProtectedGate>
                  <ProtectedGate reason={readOnly}>
                    <Button size="sm" onClick={() => router.push(`/templates?folder=${encodeURIComponent(current.id)}${current.projectId ? `&project=${encodeURIComponent(current.projectId)}` : ''}`)} disabled={locked}>
                      <LayoutTemplate className="size-3.5" /> From a template
                    </Button>
                  </ProtectedGate>
                  <ProtectedGate reason={readOnly}>
                    <Button variant="primary" size="sm" onClick={() => void create()} loading={creating} disabled={locked}>
                      New workflow
                    </Button>
                  </ProtectedGate>
                </div>
              }
            />
          </Card>
        )}
      </PageBody>

      {dialog?.kind === 'new-folder' && (
        <FolderNameDialog
          title={current ? `New folder in “${current.name}”` : project ? `New folder in ${projectLabel(project, viewer?.id)}` : 'New folder'}
          confirm="Create"
          onClose={() => setDialog(undefined)}
          onSubmit={async (name) => {
            try {
              // A subfolder is in its parent's project; a top-level one in the project picked (else the caller's personal one).
              await api(`/api/folders${current ? '' : scopeQuery}`, { method: 'POST', json: { name, ...(current && { parentId: current.id }) } });
              await load();
              return true;
            } catch (e) {
              toast.error((e as Error).message);
              return false;
            }
          }}
        />
      )}
      {dialog?.kind === 'rename' && (
        <FolderNameDialog
          title="Rename folder"
          initial={dialog.folder.name}
          confirm="Rename"
          onClose={() => setDialog(undefined)}
          onSubmit={async (name) => {
            try {
              await api(`/api/folders/${dialog.folder.id}`, { method: 'PATCH', json: { name } });
              await load();
              return true;
            } catch (e) {
              toast.error((e as Error).message);
              return false;
            }
          }}
        />
      )}
      {dialog?.kind === 'move' && (
        <MoveDialog
          name={dialog.workflow.name}
          folders={dialog.workflow.ownership ? folders.filter((f) => !f.projectId || f.projectId === dialog.workflow.ownership!.projectId) : folders}
          current={known(dialog.workflow.folderId)}
          onClose={() => setDialog(undefined)}
          onMove={(target) => move(dialog.workflow.id, target)}
        />
      )}
      {dialog?.kind === 'share' && <ShareDialog kind="workflow" id={dialog.workflow.id} name={dialog.workflow.name} onClose={() => setDialog(undefined)} onChanged={() => void load()} />}
      {dialog?.kind === 'transfer' && (
        <MoveToProjectDialog kind="workflow" id={dialog.workflow.id} name={dialog.workflow.name} currentProjectId={dialog.workflow.ownership?.projectId} onClose={() => setDialog(undefined)} onMoved={() => void load()} />
      )}
      <ImportReportDialog />
    </>
  );
}
