'use client';
/**
 * How a node looks on a canvas, shared by the editor and the read-only
 * execution view. n8n's shapes: square tiles with the label underneath,
 * D-shaped triggers, wide AI roots with sub-node ports along the bottom and
 * round sub-nodes. Colour comes from the node (or its plugin / category).
 */
import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { Handle, Position } from '@xyflow/react';
import { indexedPorts } from '@landflow/protocol';
import { Check, Hourglass, Pause, Pin, Plus, X, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { duration, languageMeta, TRANSPORT_META } from '@/lib/client/format';
import { DevOnly, useDeveloperDetails } from '@/lib/client/developer-details';
import { nodeColor, tint } from '@/lib/client/node-style';
import type { NodeStatus } from '@/lib/client/run-data';
import type { ConnectionType, NodeTypeInfo, PortDescriptor } from '@/lib/shared/types';
import { AgentAvatar, type AvatarSource } from '../agents/avatar';
import { NodeIcon } from '../ui/icon';

export const TILE = 88;
export const WIDE_TILE = 240;
const AI_LABEL: Record<string, string> = {
  ai_languageModel: 'Model',
  ai_memory: 'Memory',
  ai_tool: 'Tool',
  ai_embedding: 'Embedding',
  ai_document: 'Document',
  ai_textSplitter: 'Text Splitter',
  ai_retriever: 'Retriever',
  ai_reranker: 'Reranker',
};

export function handleId(type: ConnectionType, index: number) {
  return `${type}:${index}`;
}

function subtitleOf(template: string | undefined, parameters: Record<string, unknown>) {
  if (!template) return undefined;
  const text = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => {
    const value = parameters[key];
    return value === undefined || value === null ? '' : typeof value === 'object' ? '…' : String(value);
  });
  // An empty value leaves its separator behind ("insert · "): drop separators at either end.
  return text.replace(/^[\s·|]+|[\s·|]+$/g, '') || undefined;
}

/**
 * The ports `parameters` show, indexed by port type ([{ port, index }]) so handle ids stay stable: a port
 * hidden by its displayOptions (a vector store's Tool output outside “As Tool” mode) keeps its index.
 */
function indexPorts(ports: PortDescriptor[], parameters: Record<string, unknown>) {
  return indexedPorts(ports, parameters).filter((p) => p.visible);
}

const slotLabel = (port: PortDescriptor) => `${port.displayName ?? AI_LABEL[port.type] ?? ''}${port.required ? '*' : ''}`;

/**
 * How wide an agent-shaped node must be for its sub-node slot labels (11px, about 6px a character) not to touch: slots
 * sit evenly along the bottom, so the widest neighbouring pair sets the pitch.
 */
function slotsWidth(ports: Array<{ port: PortDescriptor }>) {
  const widths = ports.map(({ port }) => slotLabel(port).length * 6);
  let pitch = 0;
  for (let i = 0; i + 1 < widths.length; i++) pitch = Math.max(pitch, (widths[i] + widths[i + 1]) / 2 + 12);
  return Math.ceil(pitch * (ports.length + 1));
}

/** Drawn round: sub-nodes, nodes attached as tools, and nodes whose shown outputs all go to root nodes (a vector store in a retrieve mode). */
/** Whether a node shows how long it ran (over its corner when wide, under its name otherwise). */
export const ranFor = (status: NodeStatus | undefined) => Boolean(status && (status.state === 'success' || status.state === 'error') && status.durationMs !== undefined);

export function isCompact(descriptor: NodeTypeInfo['descriptor'] | undefined, parameters: Record<string, unknown>, asTool?: boolean) {
  if (descriptor?.kind === 'subnode' || asTool) return true;
  const outputs = indexPorts(descriptor?.outputs ?? [{ type: 'main' }], parameters);
  return outputs.length > 0 && outputs.every((p) => p.port.type !== 'main');
}

export interface NodeTileProps {
  name: string;
  info?: NodeTypeInfo;
  parameters: Record<string, unknown>;
  status?: NodeStatus;
  disabled?: boolean;
  selected?: boolean;
  breakpoint?: boolean;
  pinned?: boolean;
  /** Attached to an agent's tool port: drawn as a round sub-node. */
  asTool?: boolean;
  /** Source handle ids that already have an outgoing edge. */
  connectedOutputs?: string[];
  /** Target handle id of every attached sub-node edge. */
  subConnections?: Array<string | null | undefined>;
  readOnly?: boolean;
  onAddFromOutput?: (handleId: string) => void;
  onAddSubnode?: (handleId: string, type: ConnectionType) => void;
  onToggleBreakpoint?: () => void;
  /** Just added: pops in. Only the visual frame animates, so handle positions stay measurable. */
  fresh?: boolean;
  /** The agent the node stands for (Run an Agent's agent, a team's lead): its face replaces the node's icon. */
  face?: AvatarSource;
  /**
   * What a wide node shows while it works or after it ran (a team's member at work: components/editor/team-live.tsx):
   * `head` replaces the icon and name, `body` sits under them and grows the tile, and `color` tints the running frame.
   */
  live?: NodeLive;
  /** Names for the sub-node slots by connection type, over the descriptor's: a team node's "Lead's model" (the new look). */
  slotNames?: Partial<Record<ConnectionType, string>>;
  /** Toolbars and overlays rendered inside the node. */
  children?: ReactNode;
}

export interface NodeLive {
  head?: ReactNode;
  body?: ReactNode;
  color?: string;
}

/** Status mark in the tile's bottom-right corner, n8n style. */
function StatusMark({ status, compact }: { status?: NodeStatus; compact?: boolean }) {
  if (!status || status.state === 'idle' || status.state === 'running') return null;
  const base = cn(
    'absolute z-10 grid place-items-center rounded-full border-2 border-sf animate-pop',
    compact ? '-bottom-0.5 -right-0.5 size-[18px]' : 'bottom-1.5 right-1.5 size-[18px]',
  );
  if (status.state === 'paused')
    return (
      <span className={cn(base, 'bg-warn text-bg')}>
        <Pause className="size-2.5" fill="currentColor" strokeWidth={0} />
      </span>
    );
  if (status.state === 'waiting')
    return (
      <span title={status.wait ?? 'Waiting'} className={cn(base, 'bg-viz-1 text-bg')}>
        <Hourglass className="size-2.5" strokeWidth={3} />
      </span>
    );
  if (status.state === 'error')
    return (
      <span title={status.error} className={cn(base, 'bg-rd text-bg')}>
        <X className="size-2.5" strokeWidth={3.5} />
      </span>
    );
  return (
    <span title={status.reused ? 'Reused from the earlier run' : 'Succeeded'} className={cn(base, status.reused ? 'bg-t3 text-bg' : 'bg-gn text-bg')}>
      <Check className="size-2.5" strokeWidth={3.5} />
    </span>
  );
}

function frameClasses(status: NodeStatus | undefined, selected: boolean | undefined, unavailable: boolean) {
  const state = status?.state ?? 'idle';
  return cn(
    'border-[1.5px] transition-[border-color,box-shadow,transform] duration-200',
    unavailable ? 'border-dashed border-bd' : 'border-bd',
    state === 'running' && 'node-running border-transparent',
    state === 'paused' && 'border-warn shadow-[0_0_0_4px_var(--warndim)] animate-pulse-soft',
    state === 'waiting' && 'border-viz-1 shadow-[0_0_0_4px_color-mix(in_oklab,var(--viz-1)_16%,transparent)]',
    state === 'error' && 'border-rd shadow-[0_0_0_4px_var(--rddim)] animate-shake',
    state === 'success' && (status?.reused ? 'border-dashed border-t3' : 'border-gn'),
    selected && 'shadow-[0_0_0_2px_var(--sf),0_0_0_4px_var(--acbd)]',
  );
}

export function NodeTile(props: NodeTileProps) {
  const {
    name,
    info,
    parameters,
    status,
    disabled,
    selected,
    breakpoint,
    pinned,
    asTool,
    connectedOutputs = [],
    subConnections = [],
    readOnly,
    onAddFromOutput,
    onAddSubnode,
    onToggleBreakpoint,
    fresh,
    face,
    live,
    slotNames,
    children,
  } = props;
  const descriptor = info?.descriptor;
  const kind = descriptor?.kind ?? 'action';
  const inputs = useMemo(
    () => indexPorts(descriptor?.inputs ?? [{ type: 'main' }], parameters).map((p) => (slotNames?.[p.port.type] ? { ...p, port: { ...p.port, displayName: slotNames[p.port.type] } } : p)),
    [descriptor, parameters, slotNames],
  );
  const outputs = useMemo(() => indexPorts(descriptor?.outputs ?? [{ type: 'main' }], parameters), [descriptor, parameters]);
  const mainIn = inputs.filter((p) => p.port.type === 'main');
  const aiIn = inputs.filter((p) => p.port.type !== 'main');
  const mainOut = outputs.filter((p) => p.port.type === 'main');
  const aiOut = outputs.filter((p) => p.port.type !== 'main');
  const compact = isCompact(descriptor, parameters, asTool);
  const wide = !compact && aiIn.length > 0;
  const isTrigger = kind === 'trigger';
  const unavailable = !info || !info.available;
  const color = nodeColor(info);
  const subtitle = subtitleOf(descriptor?.subtitle, parameters);
  const lang = info && info.pluginId !== 'core' ? languageMeta(info.language) : undefined;
  const ran = ranFor(status);
  const developerDetails = useDeveloperDetails();
  const showLang = Boolean(lang) && developerDetails;
  const style = { '--node': live?.color ?? color } as CSSProperties;
  const isImage = Boolean(descriptor?.icon && /^(https?:|data:)/.test(descriptor.icon));

  const meta = (showLang || unavailable || ran) && (
    <div className="mt-0.5 flex items-center justify-center gap-1 whitespace-nowrap font-mono text-[10px] text-t3">
      {lang && showLang && (
        <DevOnly>
          <span className="size-1.5 rounded-full" style={{ background: lang.color }} />
          {lang.short} · {TRANSPORT_META[info!.transport].label}
        </DevOnly>
      )}
      {unavailable && <span className="text-warn">{info ? 'offline' : 'unknown type'}</span>}
      {ran && (
        <span>
          {showLang ? '· ' : ''}
          {status!.reused ? 'reused' : duration(status!.durationMs)}
        </span>
      )}
    </div>
  );

  const breakpointDot = breakpoint && (
    <button
      title="Breakpoint: click to remove"
      onClick={(e) => {
        e.stopPropagation();
        onToggleBreakpoint?.();
      }}
      className="nodrag absolute -left-1.5 -top-1.5 z-20 size-3.5 rounded-full border-2 border-sf bg-rd shadow-[0_0_0_3px_var(--rddim)]"
    />
  );
  const pinMark = pinned && (
    <span
      title="Output is pinned: the node returns this data instead of running"
      className="absolute -right-1.5 -top-1.5 z-20 grid size-[18px] place-items-center rounded-full border-2 border-sf bg-viz-7 text-bg"
    >
      <Pin className="size-2.5" strokeWidth={2.5} />
    </span>
  );
  const pausedLabel =
    status?.state === 'paused' ? (
      <div className="absolute -top-6 left-1/2 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full bg-warn px-2 py-px text-[10px] font-semibold text-bg animate-in">
        <Pause className="size-2.5" fill="currentColor" strokeWidth={0} /> Paused here
      </div>
    ) : status?.state === 'waiting' ? (
      // What it waits for, on hover (and for screen readers): "Waiting until 14:05", "Waiting on 2 of 3 sub-workflows"…
      <div
        role="status"
        title={status.wait ?? 'Waiting'}
        aria-label={status.wait ?? 'Waiting'}
        className="absolute -top-6 left-1/2 z-20 flex -translate-x-1/2 cursor-help items-center gap-1 whitespace-nowrap rounded-full bg-viz-1 px-2 py-px text-[10px] font-semibold text-bg animate-in"
      >
        <Hourglass className="size-2.5" strokeWidth={2.75} /> Waiting
      </div>
    ) : null;

  /** Sub-node slots along the bottom (AI roots, and sub-nodes that take sub-nodes of their own). */
  const aiInputs = aiIn.map(({ port, index }, i) => {
    const hid = handleId(port.type, index);
    const connected = subConnections.filter((h) => h === hid).length;
    const missing = port.required && !connected;
    const left = `${((i + 1) / (aiIn.length + 1)) * 100}%`;
    return (
      <div key={hid}>
        <Handle
          id={hid}
          type="target"
          position={Position.Bottom}
          isConnectable={!readOnly}
          style={{ left }}
          className={cn('!size-2.5 !rotate-45 !rounded-[2px] !border-[1.5px] !bg-sf', missing ? '!border-rd' : '!border-t2')}
        />
        <div className="absolute top-full flex -translate-x-1/2 flex-col items-center pt-2.5" style={{ left }}>
          <span className={cn('whitespace-nowrap rounded bg-bg px-0.5 text-[11px]', missing ? 'text-rd' : 'text-t3')}>{slotLabel(port)}</span>
          {!readOnly && onAddSubnode && (!port.maxConnections || connected < port.maxConnections) && (
            <button
              title={`Add ${(port.displayName ?? AI_LABEL[port.type]).toLowerCase()}`}
              onClick={(e) => {
                e.stopPropagation();
                onAddSubnode(hid, port.type);
              }}
              className="nodrag mt-1 grid size-5 place-items-center rounded-md border border-dashed border-bd bg-sf text-t3 transition-all hover:scale-110 hover:border-solid hover:border-ac hover:bg-ac hover:text-on-ac"
            >
              <Plus className="size-3" />
            </button>
          )}
        </div>
      </div>
    );
  });

  // ---------------------------------------------------------------- sub-node
  if (compact && aiIn.length > 0) {
    // A sub-node with slots of its own (a vector store with its Embedding): a pill with the name inside.
    const outType: ConnectionType = aiOut[0]?.port.type ?? 'ai_tool';
    return (
      <div className="group relative" style={{ ...style, width: Math.max(200, aiIn.length * 104), height: 64 }}>
        {children}
        <Handle
          id={handleId(outType, 0)}
          type="source"
          position={Position.Top}
          isConnectable={!readOnly}
          className="!-top-1 !size-2.5 !rotate-45 !rounded-[2px] !border-[1.5px] !border-t2 !bg-sf"
        />
        <div
          className={cn('relative flex size-full items-center gap-3 rounded-full bg-sf px-5', frameClasses(status, selected, unavailable), disabled && 'opacity-50', fresh && 'animate-node-in')}
          style={{ background: tint(color, 8) }}
        >
          {face ? <AgentAvatar agent={face} size={36} round /> : <NodeIcon icon={descriptor?.icon} size={isImage ? 30 : 24} style={{ color }} strokeWidth={1.7} className="shrink-0" />}
          <div className="min-w-0">
            <div className={cn('truncate text-[13px] font-semibold text-t1', disabled && 'line-through')}>{name}</div>
            <div className="truncate text-[11px] text-t3">{subtitle ?? descriptor?.displayName}</div>
          </div>
          <StatusMark status={status} compact />
          {status?.uses && status.uses > 1 && (
            <span className="absolute -bottom-1 -left-2 rounded-full border border-hair bg-sf px-1.5 font-mono text-[10px] text-t2 animate-pop">×{status.uses}</span>
          )}
          {pinMark}
        </div>
        {meta && <div className="pointer-events-none absolute -top-5 right-3">{meta}</div>}
        {aiInputs}
      </div>
    );
  }

  if (compact) {
    const outType: ConnectionType = aiOut[0]?.port.type ?? 'ai_tool';
    return (
      <div className="group relative" style={{ ...style, width: 64, height: 64 }}>
        {children}
        <Handle
          id={handleId(outType, 0)}
          type="source"
          position={Position.Top}
          isConnectable={!readOnly}
          className="!-top-1 !size-2.5 !rotate-45 !rounded-[2px] !border-[1.5px] !border-t2 !bg-sf"
        />
        <div
          className={cn(
            'relative grid size-16 place-items-center rounded-full bg-sf',
            frameClasses(status, selected, unavailable),
            disabled && 'opacity-50',
            fresh && 'animate-node-in',
          )}
          style={{ background: tint(color, 8) }}
        >
          {face ? <AgentAvatar agent={face} size={48} round /> : <NodeIcon icon={descriptor?.icon} size={isImage ? 34 : 26} style={{ color }} strokeWidth={1.7} />}
          <StatusMark status={status} compact />
          {status?.uses && status.uses > 1 && (
            <span className="absolute -bottom-1 -left-2 rounded-full border border-hair bg-sf px-1.5 font-mono text-[10px] text-t2 animate-pop">
              ×{status.uses}
            </span>
          )}
          {pinMark}
        </div>
        <div className="pointer-events-none absolute left-1/2 top-full w-[150px] -translate-x-1/2 pt-1.5 text-center">
          <div className={cn('line-clamp-2 text-[12px] font-semibold leading-tight text-t1', disabled && 'line-through')}>{name}</div>
          {meta}
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------- main node
  const width = wide ? Math.max(WIDE_TILE, slotsWidth(aiIn)) : TILE;
  const height = Math.max(TILE, Math.max(mainIn.length, mainOut.length) * 30 + 22);
  const grows = wide && Boolean(live?.body);
  const head = wide && live?.head ? (
    live.head
  ) : (
    <>
      {face ? (
        <AgentAvatar agent={face} size={wide ? 40 : 54} className="transition-transform duration-200 group-hover:scale-110" />
      ) : (
        <NodeIcon
          icon={descriptor?.icon}
          size={wide ? 30 : isImage ? 46 : 38}
          style={{ color }}
          strokeWidth={1.6}
          className="shrink-0 transition-transform duration-200 group-hover:scale-110"
        />
      )}
      {wide && (
        <div className="min-w-0">
          <div className={cn('truncate text-[14px] font-semibold text-t1', disabled && 'line-through')}>{name}</div>
          <div className="truncate text-[12px] text-t3">{subtitle ?? descriptor?.displayName}</div>
        </div>
      )}
    </>
  );
  return (
    // A tile with a live body grows with it: the handles stay centred on its sides.
    <div className="group relative" style={{ ...style, width, ...(grows ? { minHeight: height } : { height }) }}>
      {children}
      {pausedLabel}
      {isTrigger && <Zap className="absolute -left-6 top-1/2 size-4 -translate-y-1/2 text-viz-2" fill="currentColor" strokeWidth={0} />}
      <div
        className={cn(
          'relative flex size-full bg-sf',
          grows ? 'flex-col rounded-[18px]' : 'items-center',
          wide && !grows ? 'gap-3 rounded-[18px] px-4' : !wide && 'justify-center',
          !wide && (isTrigger ? 'rounded-l-[44px] rounded-r-[18px]' : 'rounded-[18px]'),
          frameClasses(status, selected, unavailable),
          disabled && 'opacity-50',
          fresh && 'animate-node-in',
        )}
        style={{ background: `linear-gradient(160deg, ${tint(color, 9)}, var(--sf) 70%)` }}
      >
        {grows ? (
          <>
            <div className="flex shrink-0 items-center gap-3 px-4" style={{ height }}>
              {head}
            </div>
            {live!.body}
          </>
        ) : (
          head
        )}
        {disabled && !wide && <span className="absolute inset-x-3 top-1/2 h-[1.5px] -rotate-45 bg-t3" />}
        <StatusMark status={status} />
        {pinMark}
        {breakpointDot}
      </div>

      {!wide && (
        <div className="pointer-events-none absolute left-1/2 top-full w-[170px] -translate-x-1/2 pt-2 text-center">
          <div className={cn('line-clamp-2 text-[13px] font-semibold leading-tight text-t1', disabled && 'line-through')}>{name}</div>
          {subtitle && <div className="truncate text-[11px] text-t3">{subtitle}</div>}
          {meta}
        </div>
      )}
      {wide && meta && <div className="pointer-events-none absolute -top-5 right-1">{meta}</div>}

      {mainIn.map(({ port, index }, i) => (
        <Handle
          key={`in-${index}`}
          id={handleId('main', index)}
          type="target"
          position={Position.Left}
          isConnectable={!readOnly}
          style={{ top: `${((i + 1) / (mainIn.length + 1)) * 100}%` }}
          className="!h-4 !w-2 !rounded-[3px] !border-0 !bg-t3 transition-colors hover:!bg-ac"
        >
          {port.displayName && mainIn.length > 1 && (
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-bg px-0.5 text-[10px] text-t3">{port.displayName}</span>
          )}
        </Handle>
      ))}

      {mainOut.map(({ port, index }, i) => {
        const hid = handleId('main', index);
        const open = !connectedOutputs.includes(hid);
        const count = status?.itemCounts?.[index];
        return (
          <Handle
            key={`out-${index}`}
            id={hid}
            type="source"
            position={Position.Right}
            isConnectable={!readOnly}
            style={{ top: `${((i + 1) / (mainOut.length + 1)) * 100}%` }}
            className="!size-3 !border-[1.5px] !border-t3 !bg-sf transition-colors hover:!border-ac hover:!bg-ac"
          >
            {mainOut.length > 1 && port.displayName && (
              // The canvas colour behind it, so a line leaving another output stays under the words.
              <span className="pointer-events-none absolute bottom-full left-2.5 z-10 mb-px whitespace-nowrap rounded bg-bg px-0.5 text-[10px] text-t3">{port.displayName}</span>
            )}
            {open && !readOnly && onAddFromOutput && (
              <span className="absolute left-2.5 top-1/2 flex -translate-y-1/2 items-center">
                <span className="h-px w-6 bg-bd" />
                <button
                  title="Add a node after this (or drag)"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAddFromOutput(hid);
                  }}
                  className="nodrag nopan grid size-5 place-items-center rounded-md border border-bd bg-sf text-t3 transition-all hover:scale-110 hover:border-ac hover:bg-ac hover:text-on-ac"
                >
                  <Plus className="size-3" strokeWidth={2.5} />
                </button>
                {count !== undefined && (
                  <span className={cn('ml-1.5 rounded-full px-1.5 font-mono text-[10px]', count ? 'bg-gndim text-gn' : 'text-t3')}>{count}</span>
                )}
              </span>
            )}
          </Handle>
        );
      })}

      {descriptor?.usableAsTool && !readOnly && (
        <Handle
          id={handleId('ai_tool', 0)}
          type="source"
          position={Position.Top}
          title="Drag to an agent's Tool slot to use this node as a tool"
          className="!size-2 !rotate-45 !rounded-[2px] !border-[1.5px] !border-t3 !bg-sf opacity-0 transition-opacity group-hover:opacity-100"
        />
      )}

      {aiInputs}
    </div>
  );
}
