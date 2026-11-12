'use client';
/**
 * The Brain workbench's side bar (docs/second-brain.md#the-brain-page), one view per activity:
 * - Explorer: open editors, the repository tree (folders per type, people per department; each file with its work this
 *   week, an S when two or more teams shared it, and amber when it needs a person), the open file's outline and its
 *   backlinks;
 * - Search: pages by name, description, owner and team, the brain's facts, and the latest work;
 * - Timeline: the latest work as a history, a group per day.
 * One click opens a file in the preview tab (replaced by the next one), a double click keeps it open.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, ChevronsDownUp, FileText, Folder, FolderOpen, GitCommitHorizontal, Link2, ListTree, RefreshCw, Search as SearchIcon, Settings2, X } from 'lucide-react';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import type { BrainFact } from '@/lib/shared/brain';
import { byDay, SETTINGS, type BrainTree, type FileRef, type OutlineItem, type TreeFile, type TreeNode } from '@/lib/shared/brain-files';
import type { WikiHome, WikiPage } from '@/lib/shared/brain-wiki';
import { kindLabel, sourceLabel, TYPE_ICON } from './parts';

export interface Opener {
  /** Open a file; `pin` keeps the tab (a double click), otherwise it is the preview tab. */
  open: (ref: FileRef, options?: { pin?: boolean }) => void;
}

/** A collapsible section header, VS Code style. */
function Pane({ title, open, onToggle, actions, children, grow }: { title: string; open: boolean; onToggle: () => void; actions?: ReactNode; children: ReactNode; grow?: boolean }) {
  return (
    <div className={cn('flex min-h-0 flex-col border-t border-hair first:border-t-0', open && grow && 'flex-1')}>
      <div className="group flex h-7 shrink-0 items-center gap-1 px-1.5">
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-1 text-left text-[11px] font-semibold uppercase tracking-wide text-t2 hover:text-t1" aria-expanded={open}>
          {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
          <span className="truncate">{title}</span>
        </button>
        {open && actions && <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">{actions}</div>}
      </div>
      {open && <div className={cn('min-h-0 pb-1.5', grow ? 'flex-1 overflow-y-auto' : 'max-h-64 overflow-y-auto')}>{children}</div>}
    </div>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} className="grid size-5 place-items-center rounded text-t3 hover:bg-acdim hover:text-t1">
      {children}
    </button>
  );
}

/** A file's icon: its type's, or a plain document for index and log. */
export function FileIcon({ file, className }: { file?: Pick<TreeFile, 'type'>; className?: string }) {
  const Icon = file?.type ? TYPE_ICON[file.type] : FileText;
  const tone = file?.type === 'customer' ? 'text-viz-2' : file?.type === 'initiative' ? 'text-viz-7' : file?.type === 'person' ? 'text-viz-1' : file?.type === 'system' ? 'text-viz-4' : 'text-t3';
  return <Icon className={cn('size-3.5 shrink-0', tone, className)} aria-hidden />;
}

/** Decorations at the right of a file, like an editor's source-control letters. */
function Decorations({ file }: { file: TreeFile }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-[10.5px] font-semibold tabular-nums">
      {file.week > 0 && <span className="text-t3" title={`${file.week} work item${file.week === 1 ? '' : 's'} this week`}>{file.week}</span>}
      {file.shared && (
        <span className="text-viz-7" title="Two or more teams worked on it this week">
          S
        </span>
      )}
      {file.problems.length > 0 && (
        <span className="text-warn" title={file.problems.join(', ')}>
          !
        </span>
      )}
    </span>
  );
}

function Row({ depth, active, onClick, onDoubleClick, title, children }: { depth: number; active?: boolean; onClick: () => void; onDoubleClick?: () => void; title?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={title}
      style={{ paddingLeft: 6 + depth * 12 }}
      className={cn('flex h-[24px] w-full items-center gap-1.5 pr-2 text-left text-[12.5px] text-t2 hover:bg-acdim/60 hover:text-t1', active && 'bg-acdim text-t1 ring-1 ring-inset ring-ac/40')}
    >
      {children}
    </button>
  );
}

export function ExplorerView({
  tree,
  active,
  openTabs,
  outline,
  page,
  opener,
  onCloseTab,
  onOutline,
  onRefresh,
}: {
  tree: BrainTree;
  active?: FileRef;
  openTabs: Array<{ ref: FileRef; pinned: boolean }>;
  outline: OutlineItem[];
  page?: WikiPage;
  opener: Opener;
  onCloseTab: (ref: FileRef) => void;
  onOutline: (item: OutlineItem) => void;
  onRefresh: () => void;
}) {
  const [panes, setPanes] = useState({ editors: true, files: true, outline: true, backlinks: true });
  const toggle = (key: keyof typeof panes) => setPanes((p) => ({ ...p, [key]: !p[key] }));
  const allFolders = useMemo(() => folderPaths(tree.nodes), [tree]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  // Opening a file shows it: its folders open.
  useEffect(() => {
    const path = active ? tree.paths.get(active) : undefined;
    if (!path || path.length < 2) return;
    const parents = path.slice(0, -1).map((_, i) => path.slice(0, i + 1).join('/'));
    setClosed((c) => (parents.some((p) => c.has(p)) ? new Set([...c].filter((p) => !parents.includes(p))) : c));
  }, [active, tree]);

  const backlinks = page ? [...page.mentionedIn.map((m) => ({ ...m, why: 'links here' })), ...page.related.filter((r) => !page.mentionedIn.some((m) => m.ref === r.ref)).map((r) => ({ ref: r.ref, name: r.name, why: `${r.shared} shared item${r.shared === 1 ? '' : 's'}` }))] : [];

  const renderNodes = (nodes: TreeNode[], depth: number): ReactNode =>
    nodes.map((node) => {
      if (node.kind === 'folder') {
        const isOpen = !closed.has(node.path);
        return (
          <div key={node.path}>
            <Row depth={depth} onClick={() => setClosed((c) => (isOpen ? new Set([...c, node.path]) : new Set([...c].filter((p) => p !== node.path))))} title={node.path}>
              {isOpen ? <ChevronDown className="size-3.5 shrink-0 text-t3" /> : <ChevronRight className="size-3.5 shrink-0 text-t3" />}
              {isOpen ? <FolderOpen className="size-3.5 shrink-0 text-t3" /> : <Folder className="size-3.5 shrink-0 text-t3" />}
              <span className="truncate">{node.name}</span>
              <span className="ml-auto pl-2 text-[10.5px] tabular-nums text-t3">{countFiles(node.children)}</span>
            </Row>
            {isOpen && renderNodes(node.children, depth + 1)}
          </div>
        );
      }
      return (
        <Row key={node.ref} depth={depth} active={node.ref === active} onClick={() => opener.open(node.ref)} onDoubleClick={() => opener.open(node.ref, { pin: true })} title={`${node.title}${node.problems.length ? ` — ${node.problems.join(', ')}` : ''}`}>
          <span className="w-3.5 shrink-0" />
          <FileIcon file={node} />
          <span className={cn('truncate', node.problems.length > 0 && 'text-warn')}>{node.name}</span>
          <Decorations file={node} />
        </Row>
      );
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Pane title="Open editors" open={panes.editors} onToggle={() => toggle('editors')}>
        {openTabs.map((t) => {
          const file = tree.files.get(t.ref);
          return (
            <div key={t.ref} className="group/tab relative">
              <Row depth={0} active={t.ref === active} onClick={() => opener.open(t.ref, { pin: t.pinned })}>
                <span className="w-3.5 shrink-0" />
                {t.ref === SETTINGS ? <Settings2 className="size-3.5 shrink-0 text-t3" /> : <FileIcon file={file} />}
                <span className={cn('truncate', !t.pinned && 'italic')}>{file?.name ?? (t.ref === SETTINGS ? 'What Landflow knows' : t.ref)}</span>
                <span className="ml-1 truncate text-[11px] text-t3">{tree.paths.get(t.ref)?.slice(0, -1).join('/')}</span>
              </Row>
              <button type="button" onClick={() => onCloseTab(t.ref)} className="absolute right-1.5 top-1 hidden size-4 place-items-center rounded text-t3 hover:bg-acdim hover:text-t1 group-hover/tab:grid" aria-label={`Close ${file?.name ?? t.ref}`}>
                <X className="size-3" />
              </button>
            </div>
          );
        })}
      </Pane>
      <Pane
        title="Brain"
        open={panes.files}
        onToggle={() => toggle('files')}
        grow
        actions={
          <>
            <IconButton title="Refresh" onClick={onRefresh}>
              <RefreshCw className="size-3" />
            </IconButton>
            <IconButton title="Collapse folders" onClick={() => setClosed(new Set(allFolders))}>
              <ChevronsDownUp className="size-3" />
            </IconButton>
          </>
        }
      >
        {renderNodes(tree.nodes, 0)}
      </Pane>
      <Pane title="Outline" open={panes.outline} onToggle={() => toggle('outline')}>
        {outline.length ? (
          outline.map((o) => (
            <Row key={`${o.line}`} depth={0} onClick={() => onOutline(o)}>
              <ListTree className="size-3.5 shrink-0 text-t3" />
              <span className="truncate">{o.title}</span>
            </Row>
          ))
        ) : (
          <p className="px-3 py-1 text-[12px] text-t3">No sections.</p>
        )}
      </Pane>
      <Pane title="Backlinks" open={panes.backlinks} onToggle={() => toggle('backlinks')}>
        {backlinks.length ? (
          backlinks.map((b) => (
            <Row key={b.ref} depth={0} onClick={() => opener.open(b.ref)} onDoubleClick={() => opener.open(b.ref, { pin: true })}>
              <Link2 className="size-3.5 shrink-0 text-t3" />
              <span className="truncate">{tree.files.get(b.ref)?.name ?? b.name}</span>
              <span className="ml-auto shrink-0 pl-2 text-[11px] text-t3">{b.why}</span>
            </Row>
          ))
        ) : (
          <p className="px-3 py-1 text-[12px] text-t3">{page ? 'Nothing links here yet.' : 'Open a page to see what links to it.'}</p>
        )}
      </Pane>
    </div>
  );
}

const countFiles = (nodes: TreeNode[]): number => nodes.reduce((n, node) => n + (node.kind === 'file' ? 1 : countFiles(node.children)), 0);
const folderPaths = (nodes: TreeNode[]): string[] => nodes.flatMap((n) => (n.kind === 'folder' ? [n.path, ...folderPaths(n.children)] : []));

/** Search the brain: pages, facts and the latest work. */
export function SearchView({ home, tree, opener }: { home: WikiHome; tree: BrainTree; opener: Opener }) {
  const [q, setQ] = useState('');
  const [facts, setFacts] = useState<BrainFact[]>([]);
  const query = q.trim().toLowerCase();
  useEffect(() => {
    if (query.length < 2) return void setFacts([]);
    const timer = setTimeout(() => {
      api<{ facts: BrainFact[] }>(`/api/brain/facts?q=${encodeURIComponent(query)}&limit=20`)
        .then((r) => setFacts(r.facts))
        .catch(() => setFacts([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);
  const pages = query ? home.entries.filter((e) => `${e.name} ${e.description ?? ''} ${e.owner ?? ''} ${e.department ?? ''} ${e.teams.join(' ')}`.toLowerCase().includes(query)).slice(0, 40) : [];
  const work = query ? home.recent.filter((w) => `${w.title ?? ''} ${w.summary ?? ''} ${w.team ?? ''} ${w.actor ?? ''}`.toLowerCase().includes(query)).slice(0, 30) : [];
  const firstPage = (refs: string[]) => refs.find((r) => !r.startsWith('person/')) ?? refs[0];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-2.5 pb-2">
        <label className="flex h-7 items-center gap-1.5 rounded-md border border-bd bg-bg px-2 focus-within:border-ac">
          <SearchIcon className="size-3.5 shrink-0 text-t3" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search the brain" className="min-w-0 flex-1 bg-transparent text-[12.5px] text-t1 outline-none placeholder:text-t3" />
        </label>
        {query && (
          <p className="mt-1.5 text-[11px] text-t3">
            {pages.length} pages · {facts.length} facts · {work.length} work items
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {pages.length > 0 && <Group title="Pages" />}
        {pages.map((e) => {
          const ref = `${e.type}/${e.id}`;
          const file = tree.files.get(ref);
          return (
            <Row key={ref} depth={0} onClick={() => opener.open(ref)} onDoubleClick={() => opener.open(ref, { pin: true })} title={e.description}>
              <FileIcon file={file} />
              <span className="truncate">{e.name}</span>
              <span className="ml-auto truncate pl-2 text-[11px] text-t3">{tree.paths.get(ref)?.slice(0, -1).join('/')}</span>
            </Row>
          );
        })}
        {facts.length > 0 && <Group title="Facts" />}
        {facts.map((f) => (
          <button
            key={f.id}
            type="button"
            disabled={f.subjectType !== 'entity'}
            onClick={() => f.subjectType === 'entity' && opener.open(f.subjectId)}
            className="block w-full px-3 py-1 text-left text-[12px] hover:bg-acdim/60 disabled:cursor-default disabled:hover:bg-transparent"
          >
            <span className="font-medium text-t1">{f.subjectName ?? f.subjectId}</span>
            <span className="text-t3"> · {f.kind}</span>
            <span className="line-clamp-2 text-t2">{f.statement}</span>
          </button>
        ))}
        {work.length > 0 && <Group title="Work" />}
        {work.map((w) => (
          <button key={w.id} type="button" onClick={() => opener.open(firstPage(w.refs) ?? 'log')} className="block w-full px-3 py-1 text-left text-[12px] hover:bg-acdim/60">
            <span className="text-t1">{w.title ?? kindLabel(w.kind)}</span>
            <span className="block text-[11px] text-t3">
              {sourceLabel(w.source)} · {timeAgo(w.at)}
            </span>
          </button>
        ))}
        {query && !pages.length && !facts.length && !work.length && <p className="px-3 text-[12px] text-t3">No results.</p>}
      </div>
    </div>
  );
}

const Group = ({ title }: { title: string }) => <div className="px-3 pb-0.5 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-t3">{title}</div>;

/** The latest work as a history: a group per day, each item a line like a commit. */
export function TimelineView({ home, opener }: { home: WikiHome; opener: Opener }) {
  const names = new Map(home.entries.map((e) => [`${e.type}/${e.id}`, e.name]));
  return (
    <div className="h-full min-h-0 overflow-y-auto pb-2">
      {byDay(home.recent).map(([date, items]) => (
        <div key={date}>
          <Group title={date} />
          {items.map((w) => {
            const page = w.refs.find((r) => !r.startsWith('person/')) ?? w.refs[0];
            const person = w.refs.find((r) => r.startsWith('person/'));
            return (
              <button key={w.id} type="button" onClick={() => opener.open(page ?? 'log')} className="flex w-full gap-2 px-3 py-1 text-left hover:bg-acdim/60">
                <GitCommitHorizontal className="mt-0.5 size-3.5 shrink-0 text-t3" aria-hidden />
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] text-t1">{w.title ?? kindLabel(w.kind)}</span>
                  <span className="block truncate text-[11px] text-t3">
                    {sourceLabel(w.source)} · {(person && names.get(person)) ?? w.actor ?? 'someone'} · {timeAgo(w.at)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ))}
      {!home.recent.length && <p className="px-3 py-2 text-[12px] text-t3">No work yet.</p>}
    </div>
  );
}
