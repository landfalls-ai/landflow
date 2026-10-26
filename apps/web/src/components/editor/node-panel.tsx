'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, ChevronLeft, ChevronRight, CircleDot, Pause, PencilLine, Pin, PinOff, Play, SkipForward, X } from 'lucide-react';
import { isPropertyVisible } from '@landflow/protocol';
import { cn } from '@/lib/utils';
import { duration, languageMeta } from '@/lib/client/format';
import type { NodeItem, NodeRun } from '@/lib/shared/types';
import { Badge, LanguageBadge, TransportBadge } from '../ui/badge';
import { Button } from '../ui/button';
import { NodeIcon } from '../ui/icon';
import { FieldLabel, Input, SectionLabel, Select, Switch, Textarea } from '../ui/inputs';
import { DataView } from '../run/data-view';
import { NodeCredentials } from '../credentials/node-credentials';
import { ParamForm } from './param-form';
import { PollStatus } from './poll-status';
import { usePublication } from './publish-control';
import { parseHandle, useEditor } from './store';
import { SuggestionsCard } from './suggestions-card';
import { TriggerUrl } from './trigger-url';

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: React.ReactNode }>;
  onChange: (value: T) => void;
}) {
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
  // Saved but not published yet: the trigger URL still serves the published version.
  const unpublished = usePublication((s) => (s.workflowId === workflowId ? (s.status?.unpublishedChanges ?? false) : false));
  const [tab, setTab] = useState<'parameters' | 'settings'>('parameters');
  const pinned = useEditor((s) => (openNodeId ? s.pinData[openNodeId] : undefined));
  const nodes = useEditor((s) => s.nodes);
  /** JSON being edited as the node's pinned output (test data), or null. */
  const [pinDraft, setPinDraft] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string>();
  const [runIndex, setRunIndex] = useState(0);
  const [branch, setBranch] = useState(0);
  const close = () => useEditor.getState().openNode(undefined);

  useEffect(() => {
    setRunIndex(Math.max(0, (runs?.length ?? 1) - 1));
    setBranch(0);
  }, [openNodeId, runs?.length]);
  useEffect(() => {
    setPinDraft(null);
    setPinError(undefined);
  }, [openNodeId]);

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
    return { items: inputItems, nodeOutputs, nodeNames: upstream };
  }, [nodes, edges, allRuns, inputItems, openNodeId]);

  if (!node || !openNodeId) return null;
  const descriptor = info?.descriptor;
  const wf = node.data.wf;
  const update = (patch: Parameters<ReturnType<typeof useEditor.getState>['updateNode']>[1]) => useEditor.getState().updateNode(openNodeId, patch);
  const isTrigger = descriptor?.kind === 'trigger';
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
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-overlay p-6" onMouseDown={close}>
      {parents[0] && (
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => useEditor.getState().openNode(parents[0]!.id)}
          title={`Previous: ${parents[0].data.wf.name}`}
          className="absolute left-1 top-1/2 z-10 grid h-16 w-5 -translate-y-1/2 place-items-center rounded-full bg-sf text-t2 shadow-pop transition-colors hover:text-t1"
        >
          <ChevronLeft className="size-4" />
        </button>
      )}
      {children[0] && (
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => useEditor.getState().openNode(children[0]!.id)}
          title={`Next: ${children[0].data.wf.name}`}
          className="absolute right-1 top-1/2 z-10 grid h-16 w-5 -translate-y-1/2 place-items-center rounded-full bg-sf text-t2 shadow-pop transition-colors hover:text-t1"
        >
          <ChevronRight className="size-4" />
        </button>
      )}
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="flex h-full max-h-[860px] w-full max-w-[1480px] animate-in flex-col overflow-hidden rounded-2xl border border-hair bg-sf shadow-pop"
      >
        {/* header */}
        <div className="flex shrink-0 items-center gap-3 border-b border-hair px-4 py-2.5">
          <div className="grid size-9 place-items-center rounded-lg border border-hair bg-wl">
            <NodeIcon icon={descriptor?.icon} size={17} className="text-t1" strokeWidth={1.6} />
          </div>
          <div className="min-w-0">
            <NodeNameInput nodeId={openNodeId} name={wf.name} />
            <div className="flex items-center gap-2 text-[12px] text-t3">
              <span className="font-mono">{wf.type}</span>
              {info && info.pluginId !== 'core' && (
                <>
                  <LanguageBadge language={info.language} />
                  <TransportBadge transport={info.transport} />
                </>
              )}
              {info?.pluginId === 'core' && <TransportBadge transport="in-process" />}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {descriptor?.documentationUrl && (
              <a href={descriptor.documentationUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[13px] text-t2 hover:text-ac">
                <BookOpen className="size-3.5" /> Docs
              </a>
            )}
            {!isSubnode && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => useEditor.getState().toggleBreakpoint(openNodeId)}
                  title="Pause here when debugging (F9)"
                  className={cn(breakpoint && 'text-rd hover:text-rd')}
                >
                  <CircleDot className="size-3.5" /> {breakpoint ? 'Breakpoint on' : 'Breakpoint'}
                </Button>
                <Button
                  size="sm"
                  onClick={() => runNode('from')}
                  disabled={running}
                  title="Re-run this node and everything after it, reusing the data before it"
                >
                  <SkipForward className="size-3.5" /> Run from here
                </Button>
                <Button variant="primary" size="sm" onClick={() => runNode('only')} disabled={running} title="Run just this node with its last input">
                  <Play className="size-3.5" fill="currentColor" /> Run node
                </Button>
              </>
            )}
            <Button variant="ghost" size="icon-sm" onClick={close} aria-label="Close">
              <X className="size-4" />
            </Button>
          </div>
        </div>

        <div
          className={cn(
            'grid min-h-0 flex-1',
            isTrigger ? 'grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]' : 'grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,1fr)]',
          )}
        >
          {/* input */}
          {!isTrigger && (
            <div className="flex min-h-0 flex-col border-r border-hair bg-sf2">
              <PaneHeader title="Input" />
              {paused && (
                <div className="mx-3 mt-3 flex items-center gap-2 rounded-[10px] border border-warnbd bg-warndim px-3 py-2 text-[12px] text-warn">
                  <Pause className="size-3.5" fill="currentColor" strokeWidth={0} />
                  Paused before this node. This is the input it will receive.
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
                      Run the workflow to see what flows into this node, then drag fields into parameters.
                    </>
                  }
                />
              </div>
            </div>
          )}

          {/* parameters */}
          <div className="flex min-h-0 flex-col">
            <div className="flex h-10 shrink-0 items-end gap-1 border-b border-hair px-3">
              {(['parameters', 'settings'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn(
                    'h-9 px-3 text-[13px] capitalize text-t2 transition-colors hover:text-t1',
                    tab === t && 'font-semibold text-t1 shadow-[inset_0_-2px_0_var(--ac)]',
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              {tab === 'parameters' ? (
                <>
                  {descriptor?.description && <p className="mb-4 text-[13px] text-t2">{descriptor.description}</p>}
                  {descriptor?.triggerSource === 'poll' && (
                    <PollStatus workflowId={workflowId} nodeId={openNodeId} active={workflowActive} dirty={dirty} interval={Number(wf.parameters.pollInterval ?? 60)} />
                  )}
                  <TriggerUrl type={wf.type} parameters={wf.parameters} active={workflowActive} dirty={dirty || unpublished} nodeId={openNodeId} />
                  {descriptor?.credentials?.some((c) => isPropertyVisible(c, wf.parameters)) ? (
                    <NodeCredentials
                      nodeType={wf.type}
                      workflowId={workflowId || undefined}
                      requirements={descriptor.credentials.filter((c) => isPropertyVisible(c, wf.parameters))}
                      value={wf.credentials}
                      onChange={(credentials) => update({ credentials })}
                    />
                  ) : null}
                  {descriptor ? (
                    <ParamForm
                      nodeType={wf.type}
                      properties={descriptor.properties}
                      values={wf.parameters}
                      onChange={(parameters) => update({ parameters })}
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
                <div className="space-y-2">
                  <SettingRow label="Disabled" hint="Pass input straight through without running">
                    <Switch checked={Boolean(wf.disabled)} onChange={(v) => update({ disabled: v })} />
                  </SettingRow>
                  <SettingRow label="On error" hint="Stop the workflow or continue with the error attached to items">
                    <Select value={wf.onError ?? 'stop'} onChange={(e) => update({ onError: e.target.value as 'stop' | 'continue' })} className="w-40">
                      <option value="stop">Stop workflow</option>
                      <option value="continue">Continue</option>
                    </Select>
                  </SettingRow>
                  <SettingRow label="Retry on fail" hint="Run the node again when it errors">
                    <Switch checked={Boolean(wf.retryOnFail)} onChange={(v) => update({ retryOnFail: v })} />
                  </SettingRow>
                  {wf.retryOnFail && (
                    <SettingRow label="Max tries">
                      <Input
                        type="number"
                        min={1}
                        max={10}
                        value={wf.maxTries ?? 3}
                        onChange={(e) => update({ maxTries: Number(e.target.value) })}
                        className="w-24"
                      />
                    </SettingRow>
                  )}
                  <SettingRow label="Timeout (seconds)" hint="Fail a try that takes longer; retries and On error apply. Empty: no timeout">
                    <Input
                      type="number"
                      min={0.1}
                      max={86_400}
                      step="any"
                      value={wf.timeoutSeconds ?? ''}
                      onChange={(e) => update({ timeoutSeconds: e.target.value === '' ? undefined : Number(e.target.value) })}
                      // Out of range once typing is done: 0 or less is no timeout, the most is a day.
                      onBlur={() => {
                        const seconds = wf.timeoutSeconds;
                        if (seconds !== undefined && !(seconds >= 0.1)) update({ timeoutSeconds: undefined });
                        else if (seconds !== undefined && seconds > 86_400) update({ timeoutSeconds: 86_400 });
                      }}
                      placeholder="None"
                      aria-label="Timeout (seconds)"
                      className="w-24"
                    />
                  </SettingRow>
                  <RateLimitSetting value={wf.rateLimit} onChange={(rateLimit) => update({ rateLimit })} />
                  {isTrigger && <TriggerBufferSettings debounce={wf.debounce} batch={wf.batch} onChange={(patch) => update(patch)} />}
                  <SettingRow label="Always output data" hint="Continue down the branch even with zero items">
                    <Switch checked={Boolean(wf.alwaysOutputData)} onChange={(v) => update({ alwaysOutputData: v })} />
                  </SettingRow>
                  <SettingRow label="Execute once" hint="Only process the first item">
                    <Switch checked={Boolean(wf.executeOnce)} onChange={(v) => update({ executeOnce: v })} />
                  </SettingRow>
                  <div className="pt-2">
                    <FieldLabel>Notes</FieldLabel>
                    <Textarea
                      rows={3}
                      value={wf.notes ?? ''}
                      onChange={(e) => update({ notes: e.target.value })}
                      placeholder={descriptor?.usableAsTool ? 'Also used as the tool description for AI agents' : 'Notes for your team'}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* output */}
          <div className="flex min-h-0 flex-col border-l border-hair bg-sf2">
            <PaneHeader title="Output">
              {pinned && pinDraft === null && (
                <span className="flex animate-pop items-center gap-1 rounded-full bg-viz-7 px-2 py-px text-[11px] font-semibold text-white">
                  <Pin className="size-3" /> pinned
                </span>
              )}
              {singleOutput && pinDraft === null && (
                <>
                  <Button size="sm" variant="ghost" onClick={startPinEdit} title="Type the items this node should output: test data for the rest of the flow">
                    <PencilLine className="size-3.5" /> {pinned ? 'Edit' : isTrigger ? 'Set test data' : 'Edit output'}
                  </Button>
                  {pinned ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => useEditor.getState().setPinData(openNodeId, undefined)}
                      title="Run the node again instead of using pinned data"
                    >
                      <PinOff className="size-3.5" /> Unpin
                    </Button>
                  ) : (
                    run &&
                    !run.error && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => useEditor.getState().setPinData(openNodeId, run.outputs[0] ?? [])}
                        title="Keep this output: later runs reuse it instead of running the node"
                      >
                        <Pin className="size-3.5" /> Pin
                      </Button>
                    )
                  )}
                </>
              )}
              {runs && runs.length > 1 && (
                <select
                  value={runIndex}
                  onChange={(e) => setRunIndex(Number(e.target.value))}
                  aria-label="Run"
                  className="rounded-md border border-hair bg-wl px-1.5 py-0.5 text-[12px] text-t2"
                >
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
                <Badge tone={run.status === 'success' ? 'success' : 'danger'}>{run.status}</Badge>
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
                  {isTrigger
                    ? 'Test data: the trigger outputs these items when you execute the workflow.'
                    : 'Pinned output: the node returns these items instead of running.'}
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
                    <div>No output yet.</div>
                    {info && info.pluginId !== 'core' && (
                      <div className="max-w-xs text-[12px]">
                        This node runs in a {languageMeta(info.language).label} process and is called over {info.transport.toUpperCase()}.
                      </div>
                    )}
                    {!isSubnode && (
                      <Button size="sm" onClick={() => runNode('only')} disabled={running}>
                        <Play className="size-3.5" /> Run node
                      </Button>
                    )}
                  </div>
                }
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

type NodeSettings = Parameters<ReturnType<typeof useEditor.getState>['updateNode']>[1];

/**
 * A number input for a node setting. While typing, valid numbers go through at once; an empty field is `undefined`
 * when the setting is `optional`, otherwise the last value comes back on blur. Out-of-range values are fixed on blur.
 */
function NumberField(props: { value: number | undefined; onChange: (value: number | undefined) => void; min: number; max: number; step?: string; placeholder?: string; label: string; optional?: boolean }) {
  const { value, onChange, min, max, step, placeholder, label, optional } = props;
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  useEffect(() => setDraft((current) => (current !== '' && Number(current) === value ? current : value === undefined ? '' : String(value))), [value]);
  return (
    <Input
      type="number"
      min={min}
      max={max}
      step={step ?? 'any'}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        if (e.target.value === '') {
          if (optional) onChange(undefined);
        } else if (Number.isFinite(Number(e.target.value))) onChange(Number(e.target.value));
      }}
      onBlur={() => {
        if (draft === '' && !optional) setDraft(value === undefined ? '' : String(value));
        else if (value !== undefined && value < min) onChange(min);
        else if (value !== undefined && value > max) onChange(max);
      }}
      placeholder={placeholder}
      aria-label={label}
      className="w-20"
    />
  );
}

/** `node.rateLimit`: at most `limit` calls per `intervalSeconds`, shared by every run; calls over it wait their turn. */
function RateLimitSetting({ value, onChange }: { value: NodeSettings['rateLimit']; onChange: (value: NodeSettings['rateLimit']) => void }) {
  return (
    <SettingRow label="Rate limit" hint="At most this many calls per interval, across all runs; calls over it wait their turn. Empty: no limit">
      <div className="flex shrink-0 items-center gap-1.5 text-[12px] text-t3">
        <NumberField
          label="Calls per interval"
          optional
          min={1}
          max={100_000}
          step="1"
          placeholder="None"
          value={value?.limit}
          onChange={(limit) => onChange(limit === undefined || !(limit >= 1) ? undefined : { limit: Math.floor(limit), intervalSeconds: value?.intervalSeconds ?? 1 })}
        />
        per
        <NumberField label="Interval (seconds)" min={0.1} max={86_400} placeholder="1" value={value?.intervalSeconds} onChange={(intervalSeconds) => value && onChange({ ...value, intervalSeconds: intervalSeconds ?? 1 })} />
        s
      </div>
    </SettingRow>
  );
}

/** Trigger nodes: debounce (`node.debounce`) or batch (`node.batch`) the events of production runs. */
function TriggerBufferSettings({ debounce, batch, onChange }: { debounce: NodeSettings['debounce']; batch: NodeSettings['batch']; onChange: (patch: NodeSettings) => void }) {
  const held = 'Production runs only (webhooks, schedules, polls, public chats); manual runs are never held.';
  return (
    <>
      <SettingRow label="Debounce" hint={`Collapse events that arrive close together into one run, after a quiet window. ${held}`}>
        <Switch checked={Boolean(debounce)} onChange={(on) => onChange(on ? { debounce: { windowSeconds: 10 }, batch: undefined } : { debounce: undefined })} />
      </SettingRow>
      {debounce && (
        <div className="space-y-2 rounded-[10px] border border-hair bg-wl px-3 py-2.5 text-[12px] text-t2">
          <div className="flex items-center justify-between gap-3">
            <span>Quiet window (seconds)</span>
            <NumberField label="Quiet window (seconds)" min={0.1} max={86_400} value={debounce.windowSeconds} onChange={(windowSeconds) => onChange({ debounce: { ...debounce, windowSeconds: windowSeconds ?? 10 } })} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span title="Events with different keys are debounced separately">Key (expression)</span>
            <Input
              value={debounce.key ?? ''}
              onChange={(e) => onChange({ debounce: { ...debounce, key: e.target.value || undefined } })}
              placeholder="{{ $json.body.userId }}"
              aria-label="Debounce key"
              className="w-56 font-mono text-[12px]"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>The run gets</span>
            <Select value={debounce.mode ?? 'last'} onChange={(e) => onChange({ debounce: { ...debounce, mode: e.target.value as 'last' | 'all' } })} className="w-40">
              <option value="last">The last event</option>
              <option value="all">All events</option>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Start at the latest after (seconds)</span>
            <NumberField label="Maximum wait (seconds)" optional min={0} max={604_800} placeholder="No max" value={debounce.maxWaitSeconds} onChange={(maxWaitSeconds) => onChange({ debounce: { ...debounce, maxWaitSeconds } })} />
          </div>
          <div className="text-t3">Empty key: one window for all events. Held webhook calls are answered 202 with when the run starts.</div>
        </div>
      )}
      <SettingRow label="Batch" hint={`Collect events and start one run with all of them, when the batch is full or on a timeout. ${held}`}>
        <Switch checked={Boolean(batch)} onChange={(on) => onChange(on ? { batch: { size: 10, timeoutSeconds: 30 }, debounce: undefined } : { batch: undefined })} />
      </SettingRow>
      {batch && (
        <div className="space-y-2 rounded-[10px] border border-hair bg-wl px-3 py-2.5 text-[12px] text-t2">
          <div className="flex items-center justify-between gap-3">
            <span>Events per batch</span>
            <NumberField label="Batch size" min={1} max={10_000} step="1" value={batch.size} onChange={(size) => onChange({ batch: { ...batch, size: Math.floor(size ?? 10) } })} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>Timeout after the first event (seconds)</span>
            <NumberField label="Batch timeout (seconds)" min={0.1} max={86_400} value={batch.timeoutSeconds} onChange={(timeoutSeconds) => onChange({ batch: { ...batch, timeoutSeconds: timeoutSeconds ?? 30 } })} />
          </div>
        </div>
      )}
    </>
  );
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-[10px] border border-hair bg-wl px-3 py-2.5">
      <div>
        <div className="text-[13px] font-semibold text-t1">{label}</div>
        {hint && <div className="text-[12px] text-t3">{hint}</div>}
      </div>
      {children}
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
      aria-label="Node name"
      aria-invalid={taken || undefined}
      title={taken ? 'Another node already has this name' : undefined}
      className={cn('w-[320px] bg-transparent text-[15px] font-semibold text-t1 outline-none', taken && 'text-rd')}
    />
  );
}
