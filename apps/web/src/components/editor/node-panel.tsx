'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, ChevronLeft, ChevronRight, Pause, PencilLine, Pin, PinOff, Play, X } from 'lucide-react';
import { isPropertyVisible, withPropertyDefaults } from '@landflow/protocol';
import { cn } from '@/lib/utils';
import { duration, languageMeta } from '@/lib/client/format';
import { DevOnly } from '@/lib/client/developer-details';
import type { NodeItem, NodeRun, NodeTypeInfo } from '@/lib/shared/types';
import { Badge, LanguageBadge, TransportBadge, executionTone } from '../ui/badge';
import { RUN_STATE, type RunState } from '../run/run-status';
import { Button } from '../ui/button';
import { NodeIcon, isImageIcon } from '../ui/icon';
import { nodeSubtitle } from '@/lib/shared/node-subtitle';
import { Input, SectionLabel } from '../ui/inputs';
import { DataView } from '../run/data-view';
import { useEditLock } from './edit-lock';
import { NodeCredentials } from '../credentials/node-credentials';
import { ParamForm } from './param-form';
import { NodeSettingsPane } from './node-settings';
import { PollStatus } from './poll-status';
import { usePublication } from './publish-control';
import { usePublishedCredentialsDiffer } from './use-published-credentials';
import { parseHandle, useEditor } from './store';
import { SuggestionsCard } from './suggestions-card';
import { TriggerUrl } from './trigger-url';
import { syncTeamName } from './turn-into-team';
import { TeamNodePanel } from './team-node-panel';
import { useDialogFocus } from '../ui/use-dialog-focus';
import { isPhone, usePhone } from '@/lib/client/use-phone';

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: React.ReactNode }>; onChange: (value: T) => void }) {
  return (
    <div className="flex gap-0.5 rounded-lg border border-hair bg-wl p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex items-center gap-1 rounded-md border border-transparent px-2 py-px text-[12px] text-t2',
            value === o.value && 'border-bd bg-sf font-semibold text-t1 shadow-[0_1px_2px_var(--hair)]',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function PaneHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hair px-3">
      <SectionLabel>{title}</SectionLabel>
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}

/** The panel header's actions: Docs, one Run step (not for a sub-node) and Close. Run from here and Breakpoint are in Settings. */
export function NodeHeaderActions({ docsUrl, isSubnode, running, onRun, onClose }: { docsUrl?: string; isSubnode: boolean; running: boolean; onRun: () => void; onClose: () => void }) {
  return (
    // A phone: running and moving between steps are in the bar at the foot.
    <div className="ml-auto flex items-center gap-2 max-md:hidden">
      {docsUrl && (
        <a href={docsUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[13px] text-t2 hover:text-ac">
          <BookOpen className="size-3.5" /> Docs
        </a>
      )}
      {!isSubnode && (
        <Button variant="primary" size="sm" onClick={onRun} disabled={running} title="Run just this step with its last input">
          <Play className="size-3.5" fill="currentColor" /> Run step
        </Button>
      )}
      <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
        <X className="size-4" />
      </Button>
    </div>
  );
}

/** The node's type id and how it runs (language, transport): developer details. */
export function NodeTypeLine({ type, info }: { type: string; info?: Pick<NodeTypeInfo, 'pluginId' | 'language' | 'transport'> }) {
  return (
    <DevOnly>
      <div className="flex items-center gap-2 text-[12px] text-t3 max-md:hidden">
        <span className="font-mono">{type}</span>
        {info && info.pluginId !== 'core' && (
          <>
            <LanguageBadge language={info.language} />
            <TransportBadge transport={info.transport} />
          </>
        )}
        {info?.pluginId === 'core' && <TransportBadge transport="in-process" />}
      </div>
    </DevOnly>
  );
}

export function NodePanel() {
  const openNodeId = useEditor((s) => s.openNodeId);
  const node = useEditor((s) => s.nodes.find((n) => n.id === s.openNodeId));
  const info = useEditor((s) => (node ? s.nodeTypes[node.data.wf.type] : undefined));
  const runs = useEditor((s) => (openNodeId ? s.runs[openNodeId] : undefined));
  const edges = useEditor((s) => s.edges);
  const allRuns = useEditor((s) => s.runs);
  const running = useEditor((s) => s.running);
  const paused = useEditor((s) => (s.paused?.nodeId === openNodeId ? s.paused : undefined));
  const breakpoint = useEditor((s) => (openNodeId ? s.breakpoints.includes(openNodeId) : false));
  const workflowId = useEditor((s) => s.workflowId);
  const workflowActive = useEditor((s) => s.active);
  const dirty = useEditor((s) => s.dirty);
  // Until the lock has answered, `readOnly` is only the starting guess: nothing is picked on its own before then.
  const readOnly = useEditLock((s) => s.readOnly || !s.known);
  // Saved but not published yet: the trigger URL still serves the published version.
  const unpublished = usePublication((s) => (s.workflowId === workflowId ? (s.status?.unpublishedChanges ?? false) : false));
  const [tab, setTab] = useState<'parameters' | 'settings'>('parameters');
  // Settings past the three that matter are under More.
  const [more, setMore] = useState(false);
  const pinned = useEditor((s) => (openNodeId ? s.pinData[openNodeId] : undefined));
  const nodes = useEditor((s) => s.nodes);
  const publishedVersionId = usePublication((s) => (s.workflowId === workflowId ? s.status?.published?.versionId : undefined));
  const credentialsNotPublished = usePublishedCredentialsDiffer({
    workflowId: workflowActive ? workflowId || undefined : undefined,
    versionId: publishedVersionId,
    nodeId: openNodeId ?? undefined,
    credentials: nodes.find((n) => n.id === openNodeId)?.data.wf.credentials,
  });
  /** JSON being edited as the node's pinned output (test data), or null. */
  const [pinDraft, setPinDraft] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string>();
  const [runIndex, setRunIndex] = useState(0);
  const [branch, setBranch] = useState(0);
  const close = () => useEditor.getState().openNode(undefined);
  // A phone shows one pane at a time (docs/mobile.md#the-node-editor): Input, Parameters, Output, or Settings
  // (Parameters with the Settings tab).
  const phone = usePhone();
  const [pane, setPane] = useState<'input' | 'parameters' | 'output'>('parameters');

  useEffect(() => {
    setRunIndex(Math.max(0, (runs?.length ?? 1) - 1));
    setBranch(0);
  }, [openNodeId, runs?.length]);
  useEffect(() => {
    setPinDraft(null);
    setPinError(undefined);
  }, [openNodeId]);
  // Opened from the canvas: Parameters. Moved with ‹ ›: the same pane, to compare steps.
  const wasOpen = useRef(false);
  // A phone also starts on the Parameters tab (not Settings), or on Input when the run is paused here (its notice is there).
  useEffect(() => {
    if (!wasOpen.current && openNodeId) {
      const pausedHere = useEditor.getState().paused?.nodeId === openNodeId;
      setPane(pausedHere ? 'input' : 'parameters');
      if (isPhone()) setTab('parameters');
    }
    wasOpen.current = Boolean(openNodeId);
  }, [openNodeId]);
  const backButton = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  // A phone's editor is a dialog: focus moves to its back arrow, stays inside, and goes back to the step when it closes.
  useDialogFocus(card, phone && Boolean(openNodeId && node), {
    initial: backButton,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape inside the test-data editor cancels the edit, not the panel.
      if ((e.target as HTMLElement).dataset.pinEditor) return;
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const run: NodeRun | undefined = runs?.[runIndex];
  const inputItems = useMemo(() => {
    if (paused) return paused.inputs[0];
    if (run) return run.inputs[0];
    // Not run yet: show what the upstream node produced last time.
    const incoming = edges.find((e) => e.target === openNodeId && e.data?.connectionType === 'main');
    if (!incoming) return undefined;
    const upstream = allRuns[incoming.source]?.at(-1);
    return upstream?.outputs[parseHandle(incoming.sourceHandle).index];
  }, [paused, run, edges, allRuns, openNodeId]);

  // Expressions preview against this input and the last main output of every node, by name ($('Name')).
  const preview = useMemo(() => {
    const nodeOutputs: Record<string, NodeItem[]> = {};
    for (const n of nodes) {
      const last = allRuns[n.id]?.filter((r) => r.source === 'main').at(-1);
      if (last?.outputs[0]) nodeOutputs[n.data.wf.name] = last.outputs[0];
    }
    // Upstream nodes, nearest first, for `$('Name')` suggestions. A sub-node (tool, model) sees what its root node sees.
    const upstream: string[] = [];
    const seen = new Set<string>([openNodeId ?? '']);
    let frontier = edges.filter((e) => e.source === openNodeId && e.data?.connectionType !== 'main').map((e) => e.target);
    frontier.forEach((id) => seen.add(id));
    frontier.push(openNodeId ?? '');
    while (frontier.length) {
      const next: string[] = [];
      for (const e of edges) {
        if (e.data?.connectionType !== 'main' || !frontier.includes(e.target) || seen.has(e.source)) continue;
        seen.add(e.source);
        next.push(e.source);
        const name = nodes.find((n) => n.id === e.source)?.data.wf.name;
        if (name) upstream.push(name);
      }
      frontier = next;
    }
    return {
      items: inputItems,
      nodeOutputs,
      nodeNames: upstream,
      workflowNodes: nodes.map((n) => ({
        id: n.id,
        name: n.data.wf.name,
        type: n.data.wf.type,
        parameters: n.data.wf.parameters as Record<string, unknown>,
      })),
      self: openNodeId ?? undefined,
    };
  }, [nodes, edges, allRuns, inputItems, openNodeId]);

  if (!node || !openNodeId) return null;
  const descriptor = info?.descriptor;
  const wf = node.data.wf;
  const action = nodeSubtitle(descriptor, wf.parameters);
  // A credential can depend on a parameter (one per auth method); an unset one counts at its default.
  const credentialRequirements = descriptor?.credentials?.filter((c) => isPropertyVisible(c, withPropertyDefaults(descriptor.properties, wf.parameters))) ?? [];
  const update = (patch: Parameters<ReturnType<typeof useEditor.getState>['updateNode']>[1]) => useEditor.getState().updateNode(openNodeId, patch);
  const isTrigger = descriptor?.kind === 'trigger';
  // A trigger has no Input pane: moving to one from Input shows its Parameters.
  const shown = isTrigger && pane === 'input' ? 'parameters' : pane;
  const isSubnode = descriptor?.kind === 'subnode';
  const outputPorts = descriptor?.outputs.filter((p) => p.type === 'main') ?? [];
  const runNode = (scope: 'from' | 'only') => useEditor.getState().run?.({ kind: 'node', nodeId: openNodeId, scope });
  const singleOutput = outputPorts.length <= 1 && !isSubnode;
  const parents = edges
    .filter((e) => e.target === openNodeId && e.data?.connectionType === 'main')
    .map((e) => nodes.find((n) => n.id === e.source))
    .filter(Boolean);
  const children = edges
    .filter((e) => e.source === openNodeId && e.data?.connectionType === 'main')
    .map((e) => nodes.find((n) => n.id === e.target))
    .filter(Boolean);
  const startPinEdit = () => {
    const current = pinned ?? (run && !run.error ? run.outputs[0] : undefined) ?? [{ json: {} }];
    setPinDraft(
      JSON.stringify(
        current.map((i) => i.json),
        null,
        2,
      ),
    );
    setPinError(undefined);
  };
  const savePin = () => {
    try {
      const value = JSON.parse(pinDraft ?? '[]');
      const rows = Array.isArray(value) ? value : [value];
      if (!rows.every((r) => r && typeof r === 'object' && !Array.isArray(r))) throw new Error('Use an object or an array of objects');
      useEditor.getState().setPinData(
        openNodeId,
        rows.map((json) => ({ json })),
      );
      setPinDraft(null);
    } catch (e) {
      setPinError((e as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-overlay p-6 max-md:p-0" onMouseDown={close}>
      {parents[0] && (
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => useEditor.getState().openNode(parents[0]!.id)}
          title={`Previous: ${parents[0].data.wf.name}`}
          className="absolute left-1 top-1/2 z-10 grid h-16 w-5 -translate-y-1/2 place-items-center rounded-full bg-sf text-t2 shadow-pop transition-colors hover:text-t1 max-md:hidden"
        >
          <ChevronLeft className="size-4" />
        </button>
      )}
      {children[0] && (
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => useEditor.getState().openNode(children[0]!.id)}
          title={`Next: ${children[0].data.wf.name}`}
          className="absolute right-1 top-1/2 z-10 grid h-16 w-5 -translate-y-1/2 place-items-center rounded-full bg-sf text-t2 shadow-pop transition-colors hover:text-t1 max-md:hidden"
        >
          <ChevronRight className="size-4" />
        </button>
      )}
      <div
        onMouseDown={(e) => e.stopPropagation()}
        ref={card}
        data-node-editor
        role={phone ? 'dialog' : undefined}
        aria-modal={phone || undefined}
        aria-label={phone ? wf.name : undefined}
        className="flex h-full max-h-[860px] w-full max-w-[1480px] animate-in flex-col overflow-hidden rounded-2xl border border-hair bg-sf shadow-pop max-md:max-h-none max-md:rounded-none max-md:border-0 max-md:pt-[env(safe-area-inset-top)]"
      >
        {/* header */}
        <div className="flex shrink-0 items-center gap-3 border-b border-hair px-4 py-2.5 max-md:gap-2 max-md:px-1.5 max-md:py-1">
          <button ref={backButton} type="button" onClick={close} aria-label="Back to the flow" className="grid size-11 shrink-0 place-items-center rounded-full text-t2 hover:text-t1 md:hidden">
            <ArrowLeft className="size-5" />
          </button>
          {/* A plugin's own icon (the app's real mark) brings its tile: no frame around it. */}
          <div className={cn('grid place-items-center max-md:shrink-0', isImageIcon(descriptor?.icon) ? 'size-10' : 'size-9 rounded-lg border border-hair bg-wl')}>
            <NodeIcon icon={descriptor?.icon} size={isImageIcon(descriptor?.icon) ? 38 : 17} className="text-t1" strokeWidth={1.6} />
          </div>
          <div className="min-w-0 max-md:flex-1">
            <NodeNameInput nodeId={openNodeId} name={wf.name} />
            <NodeTypeLine type={wf.type} info={info} />
            {action && (
              <p className="max-w-[560px] truncate text-[12px] font-medium text-t2 max-md:hidden" title={action} data-node-action>
                {action}
              </p>
            )}
            {descriptor?.description && (
              <p className="max-w-[560px] truncate text-[12px] text-t3 max-md:hidden" title={descriptor.description}>
                {descriptor.description}
              </p>
            )}
          </div>
          {/* A phone: running and moving between steps are in the bar at the foot. */}
          <NodeHeaderActions docsUrl={descriptor?.documentationUrl} isSubnode={isSubnode} running={running} onRun={() => runNode('only')} onClose={close} />
        </div>

        {phone && (
          <div role="group" aria-label="Pane" className="flex shrink-0 gap-1 border-b border-hair px-2 py-1.5">
            {([...(isTrigger ? [] : ([['input', 'Input']] as const)), ['parameters', 'Parameters'], ['output', 'Output'], ['settings', 'Settings']] as const).map(([key, label]) => {
              const on = key === 'settings' ? shown === 'parameters' && tab === 'settings' : key === 'parameters' ? shown === 'parameters' && tab === 'parameters' : shown === key;
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    setPane(key === 'settings' ? 'parameters' : key);
                    if (key === 'settings' || key === 'parameters') setTab(key);
                  }}
                  className={cn('h-11 flex-1 rounded-full text-[13px] font-semibold', on ? 'bg-acdim text-ac' : 'text-t2')}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}

        <div className={cn('grid min-h-0 flex-1 max-md:flex max-md:flex-col', isTrigger ? 'grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]' : 'grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,1fr)]')}>
          {/* input */}
          {!isTrigger && (
            <div className={cn('flex min-h-0 flex-col border-r border-hair bg-sf2 max-md:flex-1 max-md:border-r-0', phone && shown !== 'input' && 'hidden')}>
              <PaneHeader title="Input" />
              {paused && (
                <div className="mx-3 mt-3 flex items-center gap-2 rounded-[10px] border border-warnbd bg-warndim px-3 py-2 text-[12px] text-warn">
                  <Pause className="size-3.5" fill="currentColor" strokeWidth={0} />
                  Paused before this step. This is the input it will receive.
                </div>
              )}
              <div className="flex min-h-0 flex-1 flex-col pt-1">
                <DataView
                  items={inputItems}
                  draggable
                  emptyLabel={
                    <>
                      No input yet.
                      <br />
                      Run the workflow to see what flows into this step
                      {phone ? ', then tap {} beside a parameter to use a field.' : ', then drag fields into parameters.'}
                    </>
                  }
                />
              </div>
            </div>
          )}

          {/* parameters */}
          <div className={cn('flex min-h-0 flex-col max-md:flex-1', phone && shown !== 'parameters' && 'hidden')}>
            <div className="flex h-10 shrink-0 items-end gap-1 border-b border-hair px-3 max-md:hidden">
              {(['parameters', 'settings'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn('h-9 px-3 text-[13px] text-t2 transition-colors hover:text-t1', tab === t && 'font-semibold text-t1 shadow-[inset_0_-2px_0_var(--ac)]')}
                >
                  {t === 'parameters' ? 'Parameters' : 'Settings'}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-5 max-md:p-4">
              {tab === 'parameters' ? (
                <>
                  {descriptor?.description && <p className="mb-4 text-[13px] text-t2 md:hidden">{descriptor.description}</p>}
                  {descriptor?.triggerSource === 'poll' && (
                    <PollStatus workflowId={workflowId} nodeId={openNodeId} active={workflowActive} dirty={dirty} interval={Number(wf.parameters.pollInterval ?? 60)} />
                  )}
                  <TriggerUrl type={wf.type} parameters={wf.parameters} active={workflowActive} dirty={dirty || unpublished} nodeId={openNodeId} />
                  {credentialRequirements.length ? (
                    <NodeCredentials
                      key={openNodeId}
                      nodeType={wf.type}
                      workflowId={workflowId || undefined}
                      requirements={credentialRequirements}
                      value={wf.credentials}
                      readOnly={readOnly}
                      publishPending={workflowActive && credentialsNotPublished}
                      onChange={(credentials) => update({ credentials })}
                    />
                  ) : null}
                  {descriptor && wf.type === 'core.runTeam' ? (
                    // The team as people with jobs, then the message and where approvals go (team-node-panel.tsx).
                    <TeamNodePanel
                      properties={descriptor.properties}
                      values={wf.parameters}
                      onChange={(parameters) => {
                        update({ parameters });
                        if (parameters.teamId !== wf.parameters.teamId) void syncTeamName(openNodeId);
                      }}
                      form={{
                        preview,
                        credentials: wf.credentials,
                        scope: workflowId ? { workflowId } : undefined,
                      }}
                    />
                  ) : descriptor ? (
                    <ParamForm
                      nodeType={wf.type}
                      properties={descriptor.properties}
                      values={wf.parameters}
                      onChange={(parameters) => {
                        update({ parameters });
                        if (wf.type === 'core.runTeam' && parameters.teamId !== wf.parameters.teamId) void syncTeamName(openNodeId);
                      }}
                      preview={preview}
                      credentials={wf.credentials}
                      scope={workflowId ? { workflowId } : undefined}
                    />
                  ) : (
                    <div className="rounded-[10px] border border-dashed border-bd p-4 text-[13px] text-t2">
                      Node type <span className="font-mono">{wf.type}</span> is not registered. Start its plugin and Landflow will discover it automatically.
                    </div>
                  )}
                </>
              ) : (
                <NodeSettingsPane
                  wf={wf}
                  update={update}
                  usableAsTool={descriptor?.usableAsTool}
                  isTrigger={isTrigger}
                  isSubnode={isSubnode}
                  breakpoint={breakpoint}
                  running={running}
                  more={more}
                  onToggleMore={() => setMore((v) => !v)}
                  onToggleBreakpoint={() => useEditor.getState().toggleBreakpoint(openNodeId)}
                  onRunFrom={() => {
                    runNode('from');
                    if (phone) setPane('output');
                  }}
                />
              )}
            </div>
          </div>

          {/* output */}
          <div className={cn('flex min-h-0 flex-col border-l border-hair bg-sf2 max-md:flex-1 max-md:border-l-0', phone && shown !== 'output' && 'hidden')}>
            <PaneHeader title="Output">
              {pinned && pinDraft === null && (
                <span className="flex animate-pop items-center gap-1 rounded-full bg-viz-7 px-2 py-px text-[11px] font-semibold text-bg">
                  <Pin className="size-3" /> pinned
                </span>
              )}
              {singleOutput && pinDraft === null && (
                <>
                  <Button size="sm" variant="ghost" onClick={startPinEdit} title="Type the items this step should output: test data for the rest of the flow">
                    <PencilLine className="size-3.5" /> {pinned ? 'Edit' : isTrigger ? 'Set test data' : 'Edit output'}
                  </Button>
                  {pinned ? (
                    <Button size="sm" variant="ghost" onClick={() => useEditor.getState().setPinData(openNodeId, undefined)} title="Run the step again instead of using pinned data">
                      <PinOff className="size-3.5" /> Unpin
                    </Button>
                  ) : (
                    run &&
                    !run.error && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => useEditor.getState().setPinData(openNodeId, run.outputs[0] ?? [])}
                        title="Keep this output: later runs reuse it instead of running the step"
                      >
                        <Pin className="size-3.5" /> Pin
                      </Button>
                    )
                  )}
                </>
              )}
              {runs && runs.length > 1 && (
                <select value={runIndex} onChange={(e) => setRunIndex(Number(e.target.value))} aria-label="Run" className="rounded-md border border-hair bg-wl px-1.5 py-0.5 text-[12px] text-t2">
                  {runs.map((r, i) => (
                    <option key={i} value={i}>
                      {r.source === 'main' ? 'Run' : r.source} {i + 1} of {runs.length}
                    </option>
                  ))}
                </select>
              )}
            </PaneHeader>
            {run && (
              <div className="flex flex-wrap items-center gap-2 px-3 pt-3 text-[12px]">
                <Badge tone={executionTone(run.status as RunState)}>{RUN_STATE[run.status as RunState]?.label ?? run.status}</Badge>
                <span className="font-mono text-t3">{duration(run.durationMs)}</span>
                {run.source !== 'main' && <Badge tone="muted">{run.source} call</Badge>}
                {run.reused && (
                  <Badge tone="muted" title={`Copied from ${run.reused.executionId}`}>
                    reused
                  </Badge>
                )}
                {outputPorts.length > 1 && (
                  <div className="ml-auto">
                    <Segmented
                      value={String(branch)}
                      onChange={(v) => setBranch(Number(v))}
                      options={outputPorts.map((port, i) => ({
                        value: String(i),
                        label: (
                          <>
                            {port.displayName ?? `out ${i}`} <span className="font-mono text-t3">{run.outputs[i]?.length ?? 0}</span>
                          </>
                        ),
                      }))}
                    />
                  </div>
                )}
              </div>
            )}
            {run?.error && (
              <div className="m-3 rounded-[10px] border border-rdbd bg-rddim p-3 text-[13px] text-rd">
                <div className="font-semibold">{run.error.message}</div>
                {run.error.description && <div className="mt-1 opacity-80">{run.error.description}</div>}
              </div>
            )}
            {run?.logs && run.logs.length > 0 && (
              <div className="mx-3 mt-2 rounded-[10px] border border-hair bg-wl p-2 font-mono text-[11px] text-t2">
                {run.logs.slice(-6).map((l, i) => (
                  <div key={i}>
                    <span className={cn(l.level === 'error' ? 'text-rd' : l.level === 'warn' ? 'text-warn' : 'text-t3')}>{l.level}</span> {l.message}
                  </div>
                ))}
              </div>
            )}
            {run && pinDraft === null && !isSubnode && <SuggestionsCard nodeId={openNodeId} run={run} />}
            {pinDraft !== null && (
              <div className="flex min-h-0 flex-1 animate-fade-up flex-col gap-2 p-3">
                <div className="flex items-center gap-2 text-[12px] text-t2">
                  <Pin className="size-3.5 text-viz-7" />
                  {isTrigger ? 'Test data: the trigger outputs these items when you execute the workflow.' : 'Pinned output: the step returns these items instead of running.'}
                </div>
                <textarea
                  autoFocus
                  data-pin-editor="1"
                  spellCheck={false}
                  value={pinDraft}
                  onChange={(e) => setPinDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') savePin();
                    if (e.key === 'Escape') setPinDraft(null);
                  }}
                  className="code-area min-h-0 flex-1 resize-none rounded-[10px] border border-bd bg-sf p-3 text-t1 outline-none focus:border-ac"
                />
                {pinError && <div className="rounded-lg border border-rdbd bg-rddim px-2.5 py-1.5 text-[12px] text-rd">{pinError}</div>}
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-t3">An object or an array of objects · ⌘↵ to save</span>
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setPinDraft(null)}>
                    Cancel
                  </Button>
                  <Button size="sm" variant="primary" onClick={savePin}>
                    <Pin className="size-3.5" /> Save and pin
                  </Button>
                </div>
              </div>
            )}
            <div className={cn('flex min-h-0 flex-1 flex-col pt-1', pinDraft !== null && 'hidden')}>
              <DataView
                items={run && !run.error ? run.outputs[branch] : pinned}
                emptyLabel={
                  <div className="flex flex-col items-center gap-3">
                    <div>No output yet.{!isSubnode && ' Use Run step.'}</div>
                    {info && info.pluginId !== 'core' && (
                      <DevOnly>
                        <div className="max-w-xs text-[12px]">
                          This step runs in a {languageMeta(info.language).label} process and is called over {info.transport.toUpperCase()}.
                        </div>
                      </DevOnly>
                    )}
                  </div>
                }
              />
            </div>
          </div>
        </div>
        {phone && !isSubnode && (
          // A phone's foot: the step before, Run step (then its output), the step after.
          <div className="flex shrink-0 items-center gap-2 border-t border-hair px-2 pt-2 pb-[max(8px,env(safe-area-inset-bottom))]">
            <button
              type="button"
              disabled={!parents[0]}
              onClick={() => parents[0] && useEditor.getState().openNode(parents[0].id)}
              aria-label={parents[0] ? `Previous step: ${parents[0].data.wf.name}` : 'No previous step'}
              className="grid size-11 shrink-0 place-items-center rounded-full border border-hair text-t2 disabled:opacity-30"
            >
              <ChevronLeft className="size-5" />
            </button>
            <Button
              variant="primary"
              className="h-11 flex-1"
              disabled={running}
              onClick={() => {
                runNode('only');
                setPane('output');
              }}
            >
              <Play className="size-4" fill="currentColor" /> Run step
            </Button>
            <button
              type="button"
              disabled={!children[0]}
              onClick={() => children[0] && useEditor.getState().openNode(children[0].id)}
              aria-label={children[0] ? `Next step: ${children[0].data.wf.name}` : 'No next step'}
              className="grid size-11 shrink-0 place-items-center rounded-full border border-hair text-t2 disabled:opacity-30"
            >
              <ChevronRight className="size-5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** The node's name. It is renamed on Enter or blur, which also points `$('Old')` references at the new name; Esc cancels. */
function NodeNameInput({ nodeId, name }: { nodeId: string; name: string }) {
  const [draft, setDraft] = useState(name);
  const cancelled = useRef(false);
  useEffect(() => setDraft(name), [name]);
  const taken = useEditor((s) => draft.trim() !== name && s.nodes.some((n) => n.id !== nodeId && n.data.wf.name === draft.trim()));
  const commit = () => {
    if (cancelled.current || !useEditor.getState().renameNode(nodeId, draft)) setDraft(name);
    cancelled.current = false;
  };
  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          cancelled.current = true;
          setDraft(name);
        }
      }}
      aria-label="Step name"
      aria-invalid={taken || undefined}
      title={taken ? 'Another step already has this name' : undefined}
      className={cn('w-[320px] bg-transparent max-md:w-full text-[15px] font-semibold text-t1 outline-none', taken && 'text-rd')}
    />
  );
}
