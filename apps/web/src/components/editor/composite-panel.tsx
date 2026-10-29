'use client';
/**
 * A composite frame's contract (docs/composites.md), opened from its header: the type and version, each slot with
 * what fills it (unbind, add one), the members in no slot (bind them), the type's properties (`$composite.params`),
 * where failures go when the type falls back, the rules and the issues with their fixes. Errors here block Publish;
 * saving never is.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '@xyflow/react';
import { AlertTriangle, Check, CircleAlert, CornerDownRight, Lock, Plus, Unlink, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { describeMatcher, slotsFor, type CompositeReport, type SlotReport } from '@/lib/shared/composites';
import { NodeIcon } from '../ui/icon';
import { Button } from '../ui/button';
import { Input, Select, Switch } from '../ui/inputs';
import { editorLookup } from './composites';
import { useEditor } from './store';

/** "one", "optional, one", "at least 2", "1–3", "any number". */
function bounds(slot: Pick<SlotReport, 'min' | 'max'>): string {
  if (slot.max === 1) return slot.min ? 'one' : 'optional, one';
  if (slot.min) return slot.max ? `${slot.min}–${slot.max}` : slot.min === 1 ? 'one or more' : `at least ${slot.min}`;
  return slot.max ? `optional, up to ${slot.max}` : 'optional, any number';
}

/** Where a node added for a slot goes: along the bottom of the frame, after what is there. */
export function slotPosition(groupId: string, index: number): { x: number; y: number } | undefined {
  const frame = useEditor.getState().groups.find((g) => g.id === groupId);
  if (!frame) return undefined;
  return { x: frame.position.x + 32 + index * 190, y: frame.position.y + Math.max(70, (frame.height ?? 300) - 150) };
}

export function CompositePanel({ groupId, report, onClose }: { groupId: string; report: CompositeReport; onClose: () => void }) {
  const nodes = useEditor((s) => s.nodes);
  const groups = useEditor((s) => s.groups);
  const nodeTypes = useEditor((s) => s.nodeTypes);
  const composites = useEditor((s) => s.composites);
  const { bindSlotOf, fixComposite, openPalette, openNode, updateGroup } = useEditor.getState();
  const lookup = editorLookup(nodeTypes, composites);
  const nameOf = (id: string) => nodes.find((n) => n.id === id)?.data.wf.name ?? groups.find((g) => g.id === id)?.data.name ?? id;
  const iconOf = (id: string) => nodeTypes[nodes.find((n) => n.id === id)?.data.wf.type ?? '']?.descriptor.icon;
  const descriptor = report.descriptor;
  const info = composites.find((c) => c.type === report.type);
  const errors = report.issues.filter((i) => i.severity === 'error');
  const warnings = report.issues.filter((i) => i.severity === 'warning');
  // As tall as the room below its top edge allows (above the Spotlight bar), measured again as the canvas moves.
  const ref = useRef<HTMLDivElement>(null);
  const [y, zoom] = useStore((s) => [s.transform[1], s.transform[2]] as const, (a, b) => a[0] === b[0] && a[1] === b[1]);
  const [room, setRoom] = useState<number>();
  useLayoutEffect(() => {
    const top = ref.current?.getBoundingClientRect().top;
    if (top !== undefined) setRoom(Math.max(240, Math.min(640, window.innerHeight - top - 100)));
  }, [y, zoom]);
  const add = (slot: SlotReport) => openPalette({ slot: { groupId, slot: slot.name }, position: slotPosition(groupId, Math.max(0, report.slots.indexOf(slot))) });
  const frame = groups.find((g) => g.id === groupId);
  const composite = frame?.data.composite;
  const setComposite = (patch: Partial<NonNullable<typeof composite>>) => composite && updateGroup(groupId, { composite: { ...composite, ...patch } });
  const params = { ...Object.fromEntries((descriptor?.properties ?? []).map((p) => [p.name, p.default])), ...composite?.params };
  const setParam = (name: string, value: unknown) => setComposite({ params: { ...composite?.params, [name]: value } });
  const fallback = composite?.fallback ?? [];
  // Failures go to a node outside the frame that takes main input.
  const inside = new Set(frame?.data.nodeIds ?? []);
  const takesMain = (type: string) => (nodeTypes[type]?.descriptor.inputs ?? []).some((i) => (typeof i === 'string' ? i : i.type) === 'main');
  const fallbackChoices = nodes.filter((n) => !inside.has(n.id) && takesMain(n.data.wf.type) && !fallback.some((f) => f.target === n.id));

  return (
    <div
      ref={ref}
      className="nodrag nowheel flex max-h-[min(70vh,640px)] w-[340px] flex-col overflow-hidden rounded-[14px] border border-hair bg-sf text-[12.5px] shadow-pop animate-in"
      style={room ? { maxHeight: room } : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-start gap-2.5 border-b border-hair px-3.5 py-3">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-[8px] border border-hair" style={descriptor?.color ? { color: descriptor.color } : undefined}>
          <NodeIcon icon={descriptor?.icon ?? 'lucide:boxes'} size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold text-t1">{descriptor?.displayName ?? report.type}</div>
          <div className="truncate font-mono text-[10.5px] text-t3">
            {report.type} v{report.version}
            {info?.source.kind === 'plugin' ? ` · ${info.source.pluginName}` : info ? ' · saved here' : ''}
          </div>
        </div>
        <button aria-label="Close" onClick={onClose} className="grid size-6 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1">
          <X className="size-3.5" />
        </button>
      </div>

      <div className="flex flex-col gap-3 overflow-y-auto px-3.5 py-3">
        {descriptor?.description && <p className="text-[12px] leading-snug text-t2">{descriptor.description}</p>}
        {report.latestVersion && (
          <div className="flex items-center gap-2 rounded-[10px] border border-hair bg-sf2 px-2.5 py-2 text-[12px] text-t2">
            <span className="flex-1">v{report.latestVersion} of this type is out.</span>
            <Button size="sm" variant="outline" onClick={() => fixComposite(groupId, { kind: 'upgrade', version: report.latestVersion! })}>
              Check against v{report.latestVersion}
            </Button>
          </div>
        )}

        {!descriptor && <p className="text-[12px] text-warn">Its contract isn’t available here (its plugin is offline or not installed), so the frame isn’t checked.</p>}

        {descriptor && (
          <section className="flex flex-col gap-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Slots</h3>
            {report.slots.map((slot) => {
              const missing = slot.filled.length < slot.min;
              const room = slot.max === undefined || slot.filled.length < slot.max;
              return (
                <div key={slot.name} className={cn('flex flex-col gap-1 rounded-[10px] border px-2.5 py-2', missing || !slot.ok ? 'border-rdbd' : 'border-hair')}>
                  <div className="flex items-center gap-1.5">
                    <span className={cn('size-1.5 shrink-0 rounded-full', slot.ok ? 'bg-gn' : 'bg-rd')} />
                    <span className="font-medium text-t1">{slot.displayName}</span>
                    {slot.locked && <Lock className="size-3 text-t3" aria-label="Locked" />}
                    <span className="ml-auto text-[11px] text-t3">{bounds(slot)}</span>
                  </div>
                  <div className="text-[11.5px] text-t3">Takes {describeMatcher(slot.accepts, lookup)}</div>
                  <div className="flex flex-wrap items-center gap-1">
                    {slot.filled.map((id) => (
                      <span key={id} className="flex h-6 items-center gap-1 rounded-full border border-hair bg-sf2 pl-1.5 pr-1 text-[11.5px] text-t1">
                        <NodeIcon icon={iconOf(id) ?? 'lucide:boxes'} size={11} />
                        <button className="max-w-[150px] truncate hover:underline" onClick={() => nodes.some((n) => n.id === id) && openNode(id)}>
                          {nameOf(id)}
                        </button>
                        {!slot.locked && (
                          <button title="Take it out of this slot (it stays in the frame)" aria-label={`Unbind ${nameOf(id)}`} onClick={() => bindSlotOf(groupId, id)} className="grid size-4 place-items-center rounded-full text-t3 hover:text-t1">
                            <Unlink className="size-2.5" />
                          </button>
                        )}
                      </span>
                    ))}
                    {room && !slot.composite && (
                      <button onClick={() => add(slot)} className="flex h-6 items-center gap-1 rounded-full border border-dashed border-bd px-2 text-[11.5px] text-t2 hover:border-ac hover:text-ac">
                        <Plus className="size-3" /> Add
                      </button>
                    )}
                    {room && slot.composite && !slot.filled.length && <span className="text-[11.5px] text-t3">Drag a composite frame of that type into this one</span>}
                  </div>
                </div>
              );
            })}
          </section>
        )}

        {descriptor && report.free.length > 0 && (
          <section className="flex flex-col gap-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{descriptor.closed ? 'Not allowed here' : 'In no slot'}</h3>
            {report.free.map((id) => {
              const node = nodes.find((n) => n.id === id);
              const fits = node ? slotsFor(report, node.data.wf.type, nodeTypes[node.data.wf.type]?.descriptor) : [];
              return (
                <div key={id} className="flex flex-wrap items-center gap-1.5">
                  <NodeIcon icon={iconOf(id) ?? 'lucide:box'} size={12} />
                  <span className="min-w-0 truncate text-t1">{nameOf(id)}</span>
                  <span className="flex-1" />
                  {fits.map((slot) => (
                    <button key={slot.name} onClick={() => bindSlotOf(groupId, id, slot.name)} className="h-6 rounded-full border border-hair px-2 text-[11.5px] text-t2 hover:border-ac hover:text-ac">
                      Bind to {slot.displayName}
                    </button>
                  ))}
                  {!fits.length && <span className="text-[11px] text-t3">fits no slot</span>}
                </div>
              );
            })}
          </section>
        )}

        {descriptor?.properties?.length ? (
          <section className="flex flex-col gap-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Properties</h3>
            {descriptor.properties.map((p) => (
              <label key={p.name} className="flex items-center gap-2">
                <span className="w-[110px] shrink-0 truncate text-[12px] text-t2" title={`$composite.params.${p.name}`}>
                  {p.displayName}
                </span>
                {p.type === 'boolean' ? (
                  <Switch checked={Boolean(params[p.name])} onChange={(v) => setParam(p.name, v)} />
                ) : p.type === 'options' && p.options?.length ? (
                  <Select className="h-7 flex-1 text-[12px]" value={String(params[p.name] ?? '')} onChange={(e) => setParam(p.name, e.target.value)}>
                    {p.options.map((o) => (
                      <option key={String(o.value)} value={String(o.value)}>
                        {o.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    className="h-7 flex-1 text-[12px]"
                    type={p.type === 'number' ? 'number' : 'text'}
                    value={String(params[p.name] ?? '')}
                    onChange={(e) => setParam(p.name, p.type === 'number' ? Number(e.target.value) : e.target.value)}
                  />
                )}
              </label>
            ))}
          </section>
        ) : null}

        {descriptor?.onError === 'fallback' && (
          <section className="flex flex-col gap-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">On failure</h3>
            <p className="text-[11.5px] leading-snug text-t3">A node failing inside stops this frame, not the run: what entered the frame goes to these nodes with the error added.</p>
            <div className="flex flex-wrap items-center gap-1">
              {fallback.map((f) => (
                <span key={f.target} className="flex h-6 items-center gap-1 rounded-full border border-hair bg-sf2 pl-1.5 pr-1 text-[11.5px] text-t1">
                  <CornerDownRight className="size-3 text-t3" />
                  <span className="max-w-[150px] truncate">{nameOf(f.target)}</span>
                  <button aria-label={`Stop sending failures to ${nameOf(f.target)}`} onClick={() => setComposite({ fallback: fallback.filter((g) => g.target !== f.target) })} className="grid size-4 place-items-center rounded-full text-t3 hover:text-t1">
                    <X className="size-2.5" />
                  </button>
                </span>
              ))}
              {fallbackChoices.length > 0 && (
                <Select aria-label="Send failures to" className="h-6 w-auto text-[11.5px]" value="" onChange={(e) => e.target.value && setComposite({ fallback: [...fallback, { target: e.target.value }] })}>
                  <option value="">Send failures to…</option>
                  {fallbackChoices.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.data.wf.name}
                    </option>
                  ))}
                </Select>
              )}
              {!fallback.length && !fallbackChoices.length && <span className="text-[11.5px] text-t3">Add a node outside the frame to send failures to.</span>}
            </div>
          </section>
        )}

        {report.rules.length > 0 && (
          <section className="flex flex-col gap-1">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Rules</h3>
            {report.rules.map((rule, i) => (
              <div key={i} className="flex items-start gap-1.5 text-[12px]">
                {rule.ok ? <Check className="mt-0.5 size-3 shrink-0 text-gn" /> : rule.rule === 'sealed' ? <AlertTriangle className="mt-0.5 size-3 shrink-0 text-warn" /> : <CircleAlert className="mt-0.5 size-3 shrink-0 text-rd" />}
                <span className={rule.ok ? 'text-t2' : 'text-t1'}>{rule.label}</span>
              </div>
            ))}
          </section>
        )}

        {report.issues.length > 0 && (
          <section className="flex flex-col gap-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
              {errors.length ? `${errors.length} to fix before publishing` : 'Warnings'}
              {errors.length > 0 && warnings.length > 0 && `, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`}
            </h3>
            {[...errors, ...warnings].map((issue, i) => (
              <div key={i} className={cn('flex items-start gap-2 rounded-[10px] border px-2.5 py-2 text-[12px]', issue.severity === 'error' ? 'border-rdbd bg-rddim text-rd' : 'border-warnbd bg-warndim text-warn')}>
                {issue.severity === 'error' ? <CircleAlert className="mt-0.5 size-3 shrink-0" /> : <AlertTriangle className="mt-0.5 size-3 shrink-0" />}
                <span className="flex-1 leading-snug">{issue.message}</span>
                {issue.fix && (
                  <button onClick={() => fixComposite(groupId, issue.fix!)} className="shrink-0 rounded-full border border-current px-2 text-[11px] font-medium leading-5 hover:bg-sf">
                    {issue.fix.kind === 'onError' ? `Set to ${issue.fix.value}` : issue.fix.kind === 'upgrade' ? `Use v${issue.fix.version}` : 'Unbind'}
                  </button>
                )}
              </div>
            ))}
          </section>
        )}
        {report.issues.length === 0 && descriptor && (
          <div className="flex items-center gap-1.5 text-[12px] text-gn">
            <Check className="size-3.5" /> Contract met
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-hair px-3.5 py-2.5">
        <span className="flex-1 text-[11px] text-t3">Errors block Publish, not Save.</span>
        <Button size="sm" variant="ghost" onClick={() => (updateGroup(groupId, { composite: undefined }), onClose())} title="Keep the nodes, drop the contract">
          Make plain group
        </Button>
      </div>
    </div>
  );
}
