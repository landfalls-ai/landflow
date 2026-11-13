'use client';
/**
 * /brain: the second brain as a repository of Markdown files in an editor's workbench (docs/second-brain.md#the-brain-page).
 *
 * - Activity bar: Explorer, Search, Timeline, and What Landflow knows (the brain's status, facts and detectors, as a tab).
 * - Side bar: the view; drag its edge to resize, ⌘B to hide.
 * - Editor: tabs (one click opens a preview tab in italics, which the next replaces; a double click or a second click
 *   keeps it), breadcrumbs, and each file as Preview or Source (⌘⇧V).
 * - Spotlight at the bottom of the editor asks the brain, about the open page unless its chip is removed (⌘I).
 * - Panel (⌘J): Problems (pages that need a person) and Suggestions. Status bar: problems, shared pages, the model, counts.
 * - ⌘P (or ⌘K): go to a file, `>` for commands, or ask Spotlight.
 * The open tabs and the side bar's width are kept in this browser. On a phone the side bar is a drawer and the activity
 * bar folds into it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Brain, ChevronRight, Code2, Eye, Files, GitCommitHorizontal, PanelBottom, PanelLeft, Search, Settings2, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import { brainTree, INDEX, indexMarkdown, LOG, logMarkdown, outlineOf, pageMarkdown, SETTINGS, urlOf, type BrainTree, type FileRef, type OutlineItem } from '@/lib/shared/brain-files';
import type { WikiHome, WikiPage, WikiSummary } from '@/lib/shared/brain-wiki';
import { CopyButton } from '../../ui/copy-button';
import { BrainPanel } from '../brain-panel';
import { ProposalCard, useProposalActions } from '../proposal-card';
import { IndexDoc, LogDoc } from './index-doc';
import { PageDoc } from './page-doc';
import { WikiNav } from './parts';
import { ExplorerView, FileIcon, SearchView, TimelineView, type Opener } from './side-views';
import { lineId, SourceView } from './source-view';
import { BrainSpotlight, focusBrainSpotlight, type SpotlightFile } from './spotlight';

type View = 'explorer' | 'search' | 'timeline';
type Mode = 'preview' | 'source';
interface Tab {
  ref: FileRef;
  pinned: boolean;
}
type Loaded = WikiPage | { error: string };

const STORE = 'landflow.brain.workbench';
const isPage = (ref: FileRef) => ref.includes('/');

export function BrainWorkbench({ initial }: { initial: FileRef }) {
  const [home, setHome] = useState<WikiHome>();
  const [homeError, setHomeError] = useState<string>();
  const [pages, setPages] = useState<Record<FileRef, Loaded>>({});
  const [tabs, setTabs] = useState<Tab[]>([{ ref: initial, pinned: true }]);
  const [active, setActive] = useState<FileRef | undefined>(initial);
  const [modes, setModes] = useState<Record<FileRef, Mode>>({});
  const [view, setView] = useState<View>('explorer');
  const [sidebar, setSidebar] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const [panel, setPanel] = useState<'problems' | 'suggestions' | undefined>();
  const [width, setWidth] = useState(272);
  const [quick, setQuick] = useState(false);
  const [askRequest, setAskRequest] = useState<{ question: string; key: number }>();
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  // The tabs and side bar from last time, with the file the URL names in front.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) ?? '{}') as { tabs?: Tab[]; width?: number; sidebar?: boolean };
      if (Array.isArray(saved.tabs)) {
        const restored = saved.tabs.filter((t) => typeof t.ref === 'string' && t.ref !== initial).slice(0, 20);
        setTabs([...restored.map((t) => ({ ref: t.ref, pinned: Boolean(t.pinned) })), { ref: initial, pinned: true }]);
      }
      if (typeof saved.width === 'number') setWidth(Math.min(480, Math.max(200, saved.width)));
      if (typeof saved.sidebar === 'boolean') setSidebar(saved.sidebar);
    } catch {
      // A broken entry: start fresh.
    }
  }, [initial]);
  useEffect(() => {
    localStorage.setItem(STORE, JSON.stringify({ tabs, width, sidebar }));
  }, [tabs, width, sidebar]);

  // The active tab in view, on a narrow screen too.
  useEffect(() => {
    if (active) document.querySelector(`[data-tab="${CSS.escape(active)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, tabs]);

  // The address names the open file, so a reload or a shared link opens it again.
  useEffect(() => {
    const url = urlOf(active ?? INDEX);
    if (window.location.pathname !== url) window.history.replaceState(null, '', url);
  }, [active]);

  const loadHome = useCallback(() => {
    api<WikiHome>('/api/brain/wiki')
      .then((h) => {
        setHome(h);
        setHomeError(undefined);
      })
      .catch((e: Error) => setHomeError(e.message));
  }, []);
  useEffect(loadHome, [loadHome]);

  const loadPage = useCallback((ref: FileRef) => {
    const [type, id] = [ref.slice(0, ref.indexOf('/')), ref.slice(ref.indexOf('/') + 1)];
    api<WikiPage>(`/api/brain/wiki/${encodeURIComponent(type)}/${encodeURIComponent(id)}`)
      .then((p) => setPages((all) => ({ ...all, [ref]: p })))
      .catch((e: Error) => setPages((all) => ({ ...all, [ref]: { error: e.message } })));
  }, []);
  useEffect(() => {
    if (active && isPage(active) && !pages[active]) loadPage(active);
  }, [active, pages, loadPage]);

  const open = useCallback((ref: FileRef, options: { pin?: boolean } = {}) => {
    setTabs((all) => {
      const at = all.findIndex((t) => t.ref === ref);
      // Opening the open preview tab again keeps it.
      if (at >= 0) return options.pin || ref === activeRef.current ? all.map((t) => (t.ref === ref ? { ...t, pinned: true } : t)) : all;
      const tab = { ref, pinned: Boolean(options.pin) };
      const preview = all.findIndex((t) => !t.pinned);
      if (preview >= 0 && !options.pin) return all.map((t, i) => (i === preview ? tab : t));
      const after = all.findIndex((t) => t.ref === activeRef.current);
      return [...all.slice(0, after + 1), tab, ...all.slice(after + 1)];
    });
    setActive(ref);
    setDrawer(false);
  }, []);
  const opener: Opener = useMemo(() => ({ open }), [open]);

  const close = (ref: FileRef) => {
    setTabs((all) => {
      const at = all.findIndex((t) => t.ref === ref);
      const rest = all.filter((t) => t.ref !== ref);
      if (ref === activeRef.current) setActive(rest[Math.min(at, rest.length - 1)]?.ref);
      return rest;
    });
  };
  const pin = (ref: FileRef) => setTabs((all) => all.map((t) => (t.ref === ref ? { ...t, pinned: true } : t)));

  const tree: BrainTree | undefined = useMemo(() => (home ? brainTree(home) : undefined), [home]);
  const loaded = active && isPage(active) ? pages[active] : undefined;
  const page = loaded && 'entity' in loaded ? loaded : undefined;
  const markdown = useMemo(() => {
    if (!active || !home) return undefined;
    if (active === INDEX) return indexMarkdown(home);
    if (active === LOG) return logMarkdown(home);
    return page ? pageMarkdown(page) : undefined;
  }, [active, home, page]);
  const outline = useMemo(() => (markdown ? outlineOf(markdown) : []), [markdown]);
  const mode: Mode = active ? (modes[active] ?? 'preview') : 'preview';
  const toggleMode = useCallback(() => active && active !== SETTINGS && setModes((m) => ({ ...m, [active]: (m[active] ?? 'preview') === 'preview' ? 'source' : 'preview' })), [active]);

  const jump = (item: OutlineItem) => {
    document.getElementById(mode === 'source' ? lineId(item.line) : item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setDrawer(false);
  };

  // A change on a page reloads it, and the home (its counts, problems and suggestions change with it).
  const changed = (ref: FileRef) => () => {
    pin(ref);
    loadPage(ref);
    loadHome();
  };
  const summaryWritten = (ref: FileRef) => (summary: WikiSummary) => {
    pin(ref);
    setPages((all) => {
      const p = all[ref];
      return p && 'entity' in p ? { ...all, [ref]: { ...p, summary } } : all;
    });
    loadHome();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if ((key === 'p' || key === 'k') && !e.shiftKey) {
        e.preventDefault();
        setQuick(true);
      } else if (key === 'i') {
        e.preventDefault();
        focusBrainSpotlight();
      } else if (key === 'b') {
        e.preventDefault();
        setSidebar((v) => !v);
      } else if (key === 'j') {
        e.preventDefault();
        setPanel((p) => (p ? undefined : 'problems'));
      } else if (key === 'v' && e.shiftKey) {
        e.preventDefault();
        toggleMode();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleMode]);

  const nameOf = (ref: FileRef) => (ref === SETTINGS ? 'What Landflow knows' : (tree?.files.get(ref)?.name ?? `${ref.split('/').pop()}.md`));
  const problems = tree ? [...tree.files.values()].filter((f) => f.problems.length) : [];
  const spotlightFile: SpotlightFile | undefined = active
    ? { ref: active, name: page?.entity.name ?? tree?.files.get(active)?.title ?? nameOf(active), page: isPage(active), ...(home?.shared[0] && { topShared: home.shared[0].name }) }
    : undefined;

  const sideView = home && tree && (
    <>
      {view === 'explorer' && <ExplorerView tree={tree} active={active} openTabs={tabs} outline={outline} page={page} opener={opener} onCloseTab={close} onOutline={jump} onRefresh={loadHome} />}
      {view === 'search' && <SearchView home={home} tree={tree} opener={opener} />}
      {view === 'timeline' && <TimelineView home={home} opener={opener} />}
    </>
  );
  const VIEWS: Array<{ id: View; label: string; icon: typeof Files }> = [
    { id: 'explorer', label: 'Explorer', icon: Files },
    { id: 'search', label: 'Search', icon: Search },
    { id: 'timeline', label: 'Timeline', icon: GitCommitHorizontal },
  ];
  const pickView = (id: View) => {
    if (id === view && sidebar) setSidebar(false);
    else {
      setView(id);
      setSidebar(true);
    }
  };

  return (
    <WikiNav.Provider value={open}>
      <div className="flex h-[calc(100dvh-3.5rem-env(safe-area-inset-bottom))] flex-col overflow-hidden bg-bg md:h-dvh">
        {/* Title bar: the command center. */}
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hair bg-sf2 px-2">
          <button type="button" onClick={() => setDrawer(true)} className="grid size-7 place-items-center rounded-md text-t2 hover:bg-acdim md:hidden" aria-label="Files">
            <Files className="size-4" />
          </button>
          <span className="hidden items-center gap-1.5 text-[12px] font-medium text-t2 md:flex">
            <Brain className="size-3.5 text-viz-7" aria-hidden />
            brain
          </span>
          <button
            type="button"
            onClick={() => setQuick(true)}
            className="mx-auto flex h-7 w-full max-w-[520px] items-center gap-2 rounded-md border border-bd bg-bg px-2.5 text-[12px] text-t3 hover:border-ac hover:text-t2"
          >
            <Search className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">Go to a page, run a command, or ask</span>
            <kbd className="ml-auto hidden rounded border border-hair px-1 text-[11px] sm:inline">⌘P</kbd>
          </button>
          <div className="hidden items-center gap-0.5 md:flex">
            <ToolbarButton title="Toggle side bar (⌘B)" onClick={() => setSidebar((v) => !v)} active={sidebar}>
              <PanelLeft className="size-3.5" />
            </ToolbarButton>
            <ToolbarButton title="Toggle panel (⌘J)" onClick={() => setPanel((p) => (p ? undefined : 'problems'))} active={Boolean(panel)}>
              <PanelBottom className="size-3.5" />
            </ToolbarButton>
            <ToolbarButton title="Spotlight (⌘I)" onClick={focusBrainSpotlight}>
              <Sparkles className="size-3.5" />
            </ToolbarButton>
          </div>
        </div>

        <div className="relative flex min-h-0 flex-1">
          {/* Activity bar. */}
          <nav className="hidden w-11 shrink-0 flex-col items-center gap-1 border-r border-hair bg-sf2 py-1.5 md:flex" aria-label="Views">
            {VIEWS.map((v) => (
              <ActivityButton key={v.id} label={v.label} active={sidebar && view === v.id} onClick={() => pickView(v.id)}>
                <v.icon className="size-[18px]" />
              </ActivityButton>
            ))}
            <div className="mt-auto" />
            <ActivityButton label="What Landflow knows" active={active === SETTINGS} onClick={() => open(SETTINGS, { pin: true })}>
              <Settings2 className="size-[18px]" />
            </ActivityButton>
          </nav>

          {/* Side bar: in place on a desktop, a drawer on a phone. */}
          {drawer && <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setDrawer(false)} aria-hidden />}
          <aside
            className={cn(
              'min-h-0 shrink-0 flex-col border-r border-hair bg-sf2',
              drawer ? 'fixed inset-y-0 left-0 z-40 flex w-[86vw] max-w-[340px] shadow-pop' : 'hidden',
              sidebar && 'md:static md:z-auto md:flex md:max-w-none md:shadow-none',
            )}
            style={{ width: drawer ? undefined : width }}
          >
            <div className="flex h-9 shrink-0 items-center gap-1 px-3 text-[11px] font-semibold uppercase tracking-wide text-t3">
              {VIEWS.find((v) => v.id === view)?.label}
              <div className="ml-auto flex items-center gap-0.5 md:hidden">
                {VIEWS.map((v) => (
                  <button key={v.id} type="button" onClick={() => setView(v.id)} className={cn('grid size-7 place-items-center rounded-md', view === v.id ? 'bg-acdim text-t1' : 'text-t3')} aria-label={v.label}>
                    <v.icon className="size-4" />
                  </button>
                ))}
                <button type="button" onClick={() => open(SETTINGS, { pin: true })} className="grid size-7 place-items-center rounded-md text-t3" aria-label="What Landflow knows">
                  <Settings2 className="size-4" />
                </button>
                <button type="button" onClick={() => setDrawer(false)} className="grid size-7 place-items-center rounded-md text-t3" aria-label="Close">
                  <X className="size-4" />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1">{sideView ?? <div className="m-3 h-40 rounded-lg bg-acdim animate-pulse-soft" />}</div>
          </aside>
          {sidebar && <ResizeHandle width={width} onWidth={setWidth} />}

          {/* Editor group. */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-hair bg-sf2 [scrollbar-width:none]" role="tablist">
              {tabs.map((t) => (
                <div
                  key={t.ref}
                  role="tab"
                  data-tab={t.ref}
                  aria-selected={t.ref === active}
                  tabIndex={0}
                  onClick={() => setActive(t.ref)}
                  onDoubleClick={() => pin(t.ref)}
                  onAuxClick={(e) => e.button === 1 && close(t.ref)}
                  onKeyDown={(e) => e.key === 'Enter' && setActive(t.ref)}
                  title={tree?.paths.get(t.ref)?.join('/') ?? nameOf(t.ref)}
                  className={cn(
                    'group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-hair pl-3 pr-1.5 text-[12px]',
                    t.ref === active ? 'bg-bg text-t1 shadow-[inset_0_2px_0_var(--color-ac)]' : 'text-t3 hover:text-t2',
                  )}
                >
                  {t.ref === SETTINGS ? <Settings2 className="size-3.5 shrink-0 text-t3" /> : <FileIcon file={tree?.files.get(t.ref)} />}
                  <span className={cn('max-w-[180px] truncate', !t.pinned && 'italic')}>{nameOf(t.ref)}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      close(t.ref);
                    }}
                    className={cn('grid size-5 place-items-center rounded text-t3 hover:bg-acdim hover:text-t1', t.ref === active ? 'visible' : 'invisible group-hover:visible')}
                    aria-label={`Close ${nameOf(t.ref)}`}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>

            {active && (
              <div className="flex h-7 shrink-0 items-center gap-1 border-b border-hair px-3 text-[12px] text-t3">
                <div className="flex min-w-0 items-center gap-1 overflow-hidden">
                  {(active === SETTINGS ? ['What Landflow knows'] : ['brain', ...(tree?.paths.get(active) ?? [nameOf(active)])]).map((part, i, all) => (
                    <span key={i} className="flex shrink-0 items-center gap-1 last:min-w-0 last:shrink">
                      {i > 0 && <ChevronRight className="size-3 shrink-0" />}
                      {i === all.length - 1 && active !== SETTINGS && <FileIcon file={tree?.files.get(active)} className="size-3" />}
                      <span className={cn('truncate', i === all.length - 1 && 'text-t2')}>{part}</span>
                    </span>
                  ))}
                </div>
                {markdown && (
                  <div className="ml-auto flex shrink-0 items-center gap-0.5">
                    <ToolbarButton title={mode === 'preview' ? 'Show the Markdown (⌘⇧V)' : 'Show the preview (⌘⇧V)'} onClick={toggleMode}>
                      {mode === 'preview' ? <Code2 className="size-3.5" /> : <Eye className="size-3.5" />}
                    </ToolbarButton>
                    <CopyButton text={markdown} label="Copy the Markdown" className="size-6" />
                  </div>
                )}
              </div>
            )}

            <div className="relative min-h-0 flex-1">
              <div className="h-full overflow-y-auto" id="brain-editor">
                {!active ? (
                  <Welcome />
                ) : homeError && !home ? (
                  <p className="p-6 text-[13px] text-rd">{homeError}</p>
                ) : mode === 'source' && markdown ? (
                  <div className="pb-36">
                    <SourceView markdown={markdown} />
                  </div>
                ) : (
                  <div className="mx-auto w-full max-w-3xl px-4 pb-40 pt-6 sm:px-8">
                    <FileContent
                      ref_={active}
                      home={home}
                      loaded={pages[active]}
                      onHomeChanged={loadHome}
                      onPageChanged={changed(active)}
                      onSummary={summaryWritten(active)}
                    />
                  </div>
                )}
              </div>
              <BrainSpotlight file={spotlightFile} request={askRequest} />
            </div>

            {panel && home && (
              <Panel
                panel={panel}
                onPanel={setPanel}
                problems={problems.map((f) => ({ ref: f.ref, name: f.name, path: tree?.paths.get(f.ref)?.slice(0, -1).join('/') ?? '', problems: f.problems, file: f }))}
                home={home}
                onOpen={(ref) => open(ref, { pin: true })}
                onChanged={loadHome}
              />
            )}
          </div>
        </div>

        {/* Status bar. */}
        <div className="flex h-6 shrink-0 items-center gap-3 border-t border-hair bg-sf2 px-2.5 text-[11px] text-t2">
          <span className="flex items-center gap-1">
            <Brain className="size-3" aria-hidden />
            brain
          </span>
          <button type="button" onClick={() => setPanel((p) => (p === 'problems' ? undefined : 'problems'))} className="flex items-center gap-1 hover:opacity-80" title="Pages that need a person">
            <AlertTriangle className="size-3" aria-hidden />
            {problems.length}
          </button>
          {home && (
            <button type="button" onClick={() => open(INDEX)} className="hover:opacity-80" title="Pages two or more teams worked on this week">
              {home.shared.length} shared
            </button>
          )}
          {home && home.proposals.length > 0 && (
            <button type="button" onClick={() => setPanel('suggestions')} className="hidden hover:opacity-80 sm:inline" title="Open suggestions">
              {home.proposals.length} suggestion{home.proposals.length === 1 ? '' : 's'}
            </button>
          )}
          <span className="ml-auto hidden truncate sm:inline">{home ? `${home.entries.length} pages · ${home.status.facts} facts` : ''}</span>
          {home?.status.lastStudy && <span className="hidden lg:inline">studied {timeAgo(home.status.lastStudy)}</span>}
          <span className="hidden truncate md:inline" title="LANDFLOW_BRAIN_MODEL">
            {home?.model ? `model ${home.model}` : 'no model'}
          </span>
          <button type="button" onClick={focusBrainSpotlight} className="ml-auto flex items-center gap-1 hover:opacity-80 sm:ml-0">
            <Sparkles className="size-3" aria-hidden />
            Spotlight
          </button>
        </div>

        {quick && (
          <QuickOpen
            tree={tree}
            onClose={() => setQuick(false)}
            onOpen={(ref) => open(ref, { pin: true })}
            onAsk={(question) => setAskRequest({ question, key: Date.now() })}
            commands={[
              { label: 'Open index.md', run: () => open(INDEX, { pin: true }) },
              { label: 'Open log.md', run: () => open(LOG, { pin: true }) },
              { label: 'What Landflow knows', run: () => open(SETTINGS, { pin: true }) },
              { label: 'Toggle Preview and Source', run: toggleMode },
              { label: 'Toggle the side bar', run: () => setSidebar((v) => !v) },
              { label: 'Show Problems', run: () => setPanel('problems') },
              { label: 'Show Suggestions', run: () => setPanel('suggestions') },
              { label: 'Search the brain', run: () => (setView('search'), setSidebar(true), setDrawer(true)) },
              { label: 'Refresh', run: loadHome },
              {
                label: 'Run the brain now (study and detect)',
                run: () =>
                  void api('/api/brain/run', { method: 'POST', json: { what: 'all' } })
                    .then(() => (toast.success('The brain ran'), loadHome()))
                    .catch((e: Error) => toast.error(e.message)),
              },
            ]}
          />
        )}
      </div>
    </WikiNav.Provider>
  );
}

function FileContent({ ref_, home, loaded, onHomeChanged, onPageChanged, onSummary }: { ref_: FileRef; home?: WikiHome; loaded?: Loaded; onHomeChanged: () => void; onPageChanged: () => void; onSummary: (s: WikiSummary) => void }) {
  if (ref_ === SETTINGS)
    return (
      <div className="space-y-4">
        <h1 className="text-[24px] font-semibold text-t1">What Landflow knows</h1>
        <p className="text-[13px] text-t2">The second brain itself: what it holds, a search over its facts, and how each detector has done, with Run and Backtest.</p>
        <BrainPanel />
      </div>
    );
  if (!isPage(ref_)) {
    if (!home) return <Skeleton />;
    return ref_ === LOG ? <LogDoc home={home} /> : <IndexDoc home={home} onChanged={onHomeChanged} />;
  }
  if (!loaded) return <Skeleton />;
  if ('error' in loaded)
    return (
      <div className="space-y-1 py-10 text-center">
        <p className="text-[15px] font-semibold text-t1">This page can’t be opened</p>
        <p className="text-[13px] text-t2">{loaded.error}. It may have been removed, or it is in a project you can’t open.</p>
      </div>
    );
  return <PageDoc page={loaded} onChanged={onPageChanged} onSummary={onSummary} />;
}

const Skeleton = () => (
  <div className="space-y-3">
    <div className="h-8 w-1/2 rounded-lg bg-acdim animate-pulse-soft" />
    <div className="h-40 rounded-2xl bg-acdim animate-pulse-soft" />
  </div>
);

function Welcome() {
  const rows: Array<[string, string]> = [
    ['Go to a page or command', '⌘P'],
    ['Ask Spotlight', '⌘I'],
    ['Toggle the side bar', '⌘B'],
    ['Toggle the panel', '⌘J'],
    ['Preview or Markdown', '⌘⇧V'],
  ];
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 pb-28 text-t3">
      <Brain className="size-16 text-hair" aria-hidden />
      <dl className="grid grid-cols-[auto_auto] gap-x-6 gap-y-1.5 text-[12px]">
        {rows.map(([label, keys]) => (
          <div key={label} className="contents">
            <dt className="text-right">{label}</dt>
            <dd>
              <kbd className="rounded border border-hair px-1.5 text-[11px]">{keys}</kbd>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ActivityButton({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn('relative grid size-9 place-items-center rounded-md', active ? 'text-t1 before:absolute before:-left-1 before:top-1.5 before:h-6 before:w-0.5 before:rounded before:bg-ac' : 'text-t3 hover:text-t1')}
    >
      {children}
    </button>
  );
}

function ToolbarButton({ title, onClick, active, children }: { title: string; onClick: () => void; active?: boolean; children: ReactNode }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} className={cn('grid size-6 place-items-center rounded text-t3 hover:bg-acdim hover:text-t1', active && 'text-t1')}>
      {children}
    </button>
  );
}

function ResizeHandle({ width, onWidth }: { width: number; onWidth: (w: number) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the side bar"
      className="-ml-0.5 hidden w-1 shrink-0 cursor-col-resize hover:bg-ac/40 md:block"
      onPointerDown={(e) => {
        const start = e.clientX;
        const from = width;
        const move = (m: PointerEvent) => onWidth(Math.min(480, Math.max(200, from + m.clientX - start)));
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    />
  );
}

function Panel({
  panel,
  onPanel,
  problems,
  home,
  onOpen,
  onChanged,
}: {
  panel: 'problems' | 'suggestions';
  onPanel: (p?: 'problems' | 'suggestions') => void;
  problems: Array<{ ref: FileRef; name: string; path: string; problems: string[]; file: Parameters<typeof FileIcon>[0]['file'] }>;
  home: WikiHome;
  onOpen: (ref: FileRef) => void;
  onChanged: () => void;
}) {
  const actions = useProposalActions({ onDone: onChanged });
  const tabs = [
    { id: 'problems' as const, label: 'Problems', count: problems.length },
    { id: 'suggestions' as const, label: 'Suggestions', count: home.proposals.length },
  ];
  return (
    <div className="flex h-56 shrink-0 flex-col border-t border-hair bg-bg">
      <div className="flex h-8 shrink-0 items-center gap-4 px-3">
        {tabs.map((t) => (
          <button key={t.id} type="button" onClick={() => onPanel(t.id)} className={cn('flex h-full items-center gap-1.5 border-b text-[11px] font-semibold uppercase tracking-wide', panel === t.id ? 'border-ac text-t1' : 'border-transparent text-t3 hover:text-t2')}>
            {t.label}
            <span className="rounded-full bg-acdim px-1.5 text-[11px] tabular-nums">{t.count}</span>
          </button>
        ))}
        <button type="button" onClick={() => onPanel(undefined)} className="ml-auto grid size-6 place-items-center rounded text-t3 hover:bg-acdim hover:text-t1" aria-label="Close the panel">
          <X className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {panel === 'problems' &&
          (problems.length ? (
            problems.flatMap((p) =>
              p.problems.map((problem) => (
                <button key={`${p.ref}:${problem}`} type="button" onClick={() => onOpen(p.ref)} className="flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] hover:bg-acdim/60">
                  <AlertTriangle className="size-3.5 shrink-0 text-warn" aria-hidden />
                  <span className="text-t1">{problem.charAt(0).toUpperCase() + problem.slice(1)}</span>
                  <FileIcon file={p.file} />
                  <span className="text-t2">{p.name}</span>
                  <span className="truncate text-t3">{p.path}</span>
                </button>
              )),
            )
          ) : (
            <p className="px-3 py-1 text-[12px] text-t3">No problems: every page has an owner, work in the last 30 days and a current summary.</p>
          ))}
        {panel === 'suggestions' &&
          (home.proposals.length ? (
            <div className="grid gap-2 px-3 pt-1 lg:grid-cols-2">
              {home.proposals.map((p) => (
                <ProposalCard key={p.id} proposal={p} actions={actions} compact />
              ))}
            </div>
          ) : (
            <p className="px-3 py-1 text-[12px] text-t3">No open suggestions.</p>
          ))}
      </div>
    </div>
  );
}

/** ⌘P: files by name or path; `>` for commands; anything else can also go to Spotlight as a question. */
function QuickOpen({ tree, onClose, onOpen, onAsk, commands }: { tree?: BrainTree; onClose: () => void; onOpen: (ref: FileRef) => void; onAsk: (q: string) => void; commands: Array<{ label: string; run: () => void }> }) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const commandMode = q.startsWith('>');
  const query = (commandMode ? q.slice(1) : q).trim().toLowerCase();
  type Item = { key: string; label: string; detail?: string; icon: ReactNode; run: () => void };
  const items: Item[] = commandMode
    ? commands.filter((c) => fuzzy(c.label.toLowerCase(), query)).map((c) => ({ key: c.label, label: c.label, icon: <ChevronRight className="size-3.5 text-t3" />, run: c.run }))
    : [
        ...[...(tree?.files.values() ?? [])]
          .map((f) => ({ f, path: tree?.paths.get(f.ref)?.join('/') ?? f.name }))
          .filter(({ f, path }) => !query || fuzzy(`${path} ${f.title}`.toLowerCase(), query))
          .sort((a, b) => score(b.f.title, query) - score(a.f.title, query) || b.f.week - a.f.week)
          .slice(0, 12)
          .map(({ f, path }) => ({ key: f.ref, label: f.title === 'Brain' || f.title === 'Log' ? f.name : f.title, detail: path, icon: <FileIcon file={f} />, run: () => onOpen(f.ref) })),
        ...(query ? [{ key: '?ask', label: `Ask Spotlight: “${q.trim()}”`, icon: <Sparkles className="size-3.5 text-viz-7" />, run: () => onAsk(q.trim()) }] : []),
      ];
  const choose = (item?: Item) => {
    if (!item) return;
    onClose();
    item.run();
  };
  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/30 px-3 pt-[12vh]" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Go to a page" className="h-fit w-full max-w-[600px] overflow-hidden rounded-xl border border-bd bg-sf shadow-pop" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setAt(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') (e.preventDefault(), setAt((i) => Math.min(items.length - 1, i + 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setAt((i) => Math.max(0, i - 1)));
            else if (e.key === 'Enter') choose(items[at]);
          }}
          placeholder="Go to a page · > for commands · or type a question"
          aria-label="Go to a page or command"
          className="h-10 w-full border-b border-hair bg-transparent px-3.5 text-[13px] text-t1 outline-none placeholder:text-t3"
        />
        <ul className="max-h-[50vh] overflow-y-auto py-1" role="listbox">
          {items.map((item, i) => (
            <li key={item.key} role="option" aria-selected={i === at}>
              <button type="button" onMouseEnter={() => setAt(i)} onClick={() => choose(item)} className={cn('flex w-full items-center gap-2 px-3.5 py-1.5 text-left text-[13px]', i === at ? 'bg-acdim text-t1' : 'text-t2')}>
                {item.icon}
                <span className="truncate">{item.label}</span>
                {item.detail && <span className="ml-auto truncate pl-3 text-[11px] text-t3">{item.detail}</span>}
              </button>
            </li>
          ))}
          {!items.length && <li className="px-3.5 py-2 text-[12px] text-t3">{commandMode ? 'No command matches.' : 'No page matches.'}</li>}
        </ul>
      </div>
    </div>
  );
}

/** Every letter of the query in order. */
const fuzzy = (text: string, query: string) => {
  let i = 0;
  for (const ch of text) if (ch === query[i]) i++;
  return i >= query.length;
};
const score = (title: string, query: string) => (!query ? 0 : title.toLowerCase().startsWith(query) ? 3 : title.toLowerCase().includes(query) ? 2 : 1);
