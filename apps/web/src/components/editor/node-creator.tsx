'use client';
/**
 * The node creator: n8n's right-hand panel for adding steps. An empty
 * workflow starts with "What triggers this workflow?"; after that it's "What
 * happens next?" with categories and one segment per plugin (with the icon
 * the plugin publishes). Picking a node places it, wires it to whatever the
 * panel was opened from, and opens it.
 *
 * Composites (docs/composites.md): "What happens next?" lists the composite types (picking one drops a frame with its
 * starter nodes), and opened from a composite's empty slot the panel offers only the nodes that slot accepts.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useReactFlow } from '@xyflow/react';
import { ArrowLeft, ArrowRight, ChevronRight, Puzzle, Search, X, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { languageMeta, TRANSPORT_META } from '@/lib/client/format';
import { CATEGORY_COLOR, nodeColor, tint } from '@/lib/client/node-style';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { DevOnly } from '@/lib/client/developer-details';
import { describeMatcher, nodeMatches, type CompositeTypeInfo } from '@/lib/shared/composites';
import { NodeIcon } from '../ui/icon';
import { Kbd } from '../ui/inputs';
import { api } from '@/lib/client/api';
import { useEditor, type PaletteRequest } from './store';
import { usePhone } from '@/lib/client/use-phone';
import { useDialogFocus } from '../ui/use-dialog-focus';

type Mode = 'trigger' | 'next' | 'ai_languageModel' | 'ai_memory' | 'ai_tool' | 'ai_embedding' | 'ai_document' | 'ai_textSplitter' | 'ai_retriever' | 'ai_reranker';
type View = { kind: 'root' } | { kind: 'triggers' } | { kind: 'category'; key: string } | { kind: 'plugin'; pluginId: string };

interface Segment {
  pluginId: string;
  name: string;
  icon?: string;
  color: string;
  description?: string;
  language: string;
  transport: NodeTypeInfo['transport'];
  online: boolean;
  types: NodeTypeInfo[];
}

const CATEGORIES: Array<{ key: string; title: string; description: string; icon: string; match: (t: NodeTypeInfo) => boolean }> = [
  {
    key: 'AI',
    title: 'AI',
    description: 'Build agents, call chat models and classify text',
    icon: 'lucide:bot',
    match: (t) => Boolean(t.descriptor.categories?.includes('AI')),
  },
  {
    key: 'Data',
    title: 'Data transformation',
    description: 'Edit, split, aggregate, summarize, dedupe and reshape items, dates included',
    icon: 'lucide:pencil-line',
    match: (t) => t.pluginId === 'core' && Boolean(t.descriptor.categories?.includes('Data')),
  },
  {
    key: 'Flow',
    title: 'Flow',
    description: 'Branch, switch, merge, wait or stop the flow',
    icon: 'lucide:git-branch',
    match: (t) => t.pluginId === 'core' && Boolean(t.descriptor.categories?.includes('Flow')),
  },
  {
    key: 'Core',
    title: 'Core',
    description: 'HTTP requests, code and other building blocks',
    icon: 'lucide:box',
    match: (t) => t.pluginId === 'core' && Boolean(t.descriptor.categories?.includes('Core')),
  },
];

/** Friendlier trigger titles, like n8n's "Trigger manually". */
const TRIGGER_TITLES: Record<string, { title: string; description: string }> = {
  'core.manualTrigger': { title: 'Trigger manually', description: 'Runs the flow when you click Execute. Good for getting started quickly' },
  'core.webhook': { title: 'On webhook call', description: 'Runs the flow when an HTTP request arrives' },
  'core.schedule': { title: 'On a schedule', description: 'Runs the flow every minute, hour, day or on a cron expression' },
  'core.chatTrigger': { title: 'On chat message', description: 'Runs the flow when someone sends a chat message. For AI agents' },
};

const SUBNODE_TITLES: Record<string, string> = {
  ai_languageModel: 'Choose a chat model',
  ai_memory: 'Choose a memory',
  ai_tool: 'Give the agent a tool',
  ai_embedding: 'Choose an embeddings model',
  ai_document: 'Choose a document loader',
  ai_textSplitter: 'Choose a text splitter',
  ai_retriever: 'Choose a retriever',
  ai_reranker: 'Choose a reranker',
};

/** Every search token must prefix some word of the text ("go hash", "py sent"). */
function score(text: string, query: string) {
  const words = text.toLowerCase().split(/[^a-z0-9]+/);
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return 1;
  if (tokens.every((t) => words.some((w) => w.startsWith(t)))) return 2;
  return tokens.every((t) => text.toLowerCase().includes(t)) ? 1 : 0;
}

function searchText(t: NodeTypeInfo) {
  const lang = languageMeta(t.language);
  return `${t.descriptor.displayName} ${t.pluginName} ${t.language} ${lang.short} ${t.transport} ${(t.descriptor.keywords ?? []).join(' ')} ${(t.descriptor.categories ?? []).join(' ')} ${t.type} ${t.descriptor.description}`;
}

function fits(t: NodeTypeInfo, mode: Mode) {
  const d = t.descriptor;
  if (mode === 'trigger') return d.kind === 'trigger';
  if (mode === 'next') return d.kind === 'action';
  // A sub-node slot: sub-nodes of that type, nodes with such an output in some mode (vector stores), and nodes usable as tools.
  return d.supplies === mode || d.outputs.some((p) => p.type === mode) || (mode === 'ai_tool' && Boolean(d.usableAsTool));
}

const isImage = (icon?: string) => Boolean(icon && /^(https?:|data:)/.test(icon));

/** A plugin's icon, or a monogram in its colour when it publishes none. */
export function PluginIcon({ segment, size = 32 }: { segment: Pick<Segment, 'icon' | 'name' | 'color'>; size?: number }) {
  if (segment.icon && /^(https?:|data:)/.test(segment.icon)) return <NodeIcon icon={segment.icon} size={size} />;
  if (segment.icon) return <NodeIcon icon={segment.icon} size={size * 0.6} style={{ color: segment.color }} />;
  const letters = segment.name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      className="grid place-items-center rounded-lg font-semibold text-white"
      style={{ width: size, height: size, background: segment.color, fontSize: size * 0.38 }}
    >
      {letters}
    </span>
  );
}

interface RowItem {
  key: string;
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  nav?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

function IconBox({ color, children, round, image }: { color: string; children: ReactNode; round?: boolean; image?: boolean }) {
  // Plugin-published icons bring their own badge background: no tile around them.
  if (image) return <span className="grid size-9 shrink-0 place-items-center">{children}</span>;
  return (
    <span
      className={cn('grid size-9 shrink-0 place-items-center border border-hair', round ? 'rounded-full' : 'rounded-[10px]')}
      style={{ background: tint(color, 12) }}
    >
      {children}
    </span>
  );
}

export function NodeCreator() {
  const request = useEditor((s) => s.palette);
  // A phone: the picker takes the whole screen, as a dialog that keeps the focus (docs/mobile.md#sheets-and-dialogs).
  const phone = usePhone();
  const creator = useRef<HTMLElement>(null);
  const nodeTypes = useEditor((s) => s.nodeTypes);
  const hasNodes = useEditor((s) => s.nodes.length > 0);
  const hasTrigger = useEditor((s) => s.nodes.some((n) => s.nodeTypes[n.data.wf.type]?.descriptor.kind === 'trigger'));
  const composites = useEditor((s) => s.composites);
  // Opened from a composite's slot: the slot, as its type declares it.
  const slot = useEditor((s) => {
    const target = s.palette?.slot;
    const composite = target && s.groups.find((g) => g.id === target.groupId)?.data.composite;
    if (!target || !composite) return undefined;
    const versions = s.composites.find((c) => c.type === composite.type);
    const descriptor = versions?.all?.find((d) => d.version === composite.version) ?? versions?.descriptor;
    return descriptor?.slots.find((x) => x.name === target.slot);
  });
  const { screenToFlowPosition, flowToScreenPosition, setCenter, getZoom } = useReactFlow();
  const [stack, setStack] = useState<View[]>([{ kind: 'root' }]);
  const [direction, setDirection] = useState<'push' | 'pop'>('push');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const reported = useRef(new Set<string>());
  const list = useRef<HTMLDivElement>(null);
  const close = () => useEditor.getState().openPalette(undefined);

  const mode: Mode | undefined = !request
    ? undefined
    : request.connectionType === 'trigger' || (!request.connectionType && !request.from && !hasTrigger && !hasNodes)
      ? 'trigger'
      : request.connectionType && request.connectionType !== 'main'
        ? (request.connectionType as Mode)
        : 'next';

  // Fresh panel every time it opens.
  useEffect(() => {
    if (!request) return;
    setStack([{ kind: 'root' }]);
    setQuery('');
    setActive(0);
    reported.current.clear();
    setTimeout(() => input.current?.focus(), 30);
  }, [request]);

  // Node types the governance policy blocks (Settings → Governance) are not offered.
  const all = useMemo(() => Object.values(nodeTypes).filter((t) => !t.blocked), [nodeTypes]);
  const segments = useMemo(() => {
    const map = new Map<string, Segment>();
    for (const t of all) {
      if (t.pluginId === 'core') continue;
      const seg = map.get(t.pluginId) ?? {
        pluginId: t.pluginId,
        name: t.pluginName,
        icon: t.pluginIcon,
        color: t.pluginColor ?? languageMeta(t.language).color,
        description: t.pluginDescription,
        language: t.language,
        transport: t.transport,
        online: false,
        types: [],
      };
      seg.types.push(t);
      seg.online ||= t.available;
      map.set(t.pluginId, seg);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [all]);

  const view = stack[stack.length - 1];
  const push = (v: View) => {
    setDirection('push');
    setStack((s) => [...s, v]);
    setQuery('');
    setActive(0);
    input.current?.focus();
  };
  const pop = () => {
    if (stack.length < 2) return;
    setDirection('pop');
    setStack((s) => s.slice(0, -1));
    setQuery('');
    setActive(0);
  };

  const choose = (type: NodeTypeInfo) => {
    if (!request || !mode) return;
    const state = useEditor.getState();
    let effective: PaletteRequest = request;
    if (mode === 'next' && !request.from && !request.slot) {
      // Plain "add": chain onto the selected node, or the one added last (n8n does the same).
      const anchor = state.nodes.find((n) => n.selected) ?? state.nodes.find((n) => n.id === state.lastAddedId);
      const outputs = anchor ? (state.nodeTypes[anchor.data.wf.type]?.descriptor.outputs.filter((p) => p.type === 'main').length ?? 0) : 0;
      if (anchor && outputs) {
        const used = new Set(state.edges.filter((e) => e.source === anchor.id && e.data?.connectionType === 'main').map((e) => e.sourceHandle));
        const free = Array.from({ length: outputs }, (_, i) => `main:${i}`).find((h) => !used.has(h)) ?? 'main:0';
        effective = { ...request, from: { nodeId: anchor.id, handleId: free, handleType: 'source' } };
      }
    }
    // A trigger added to an existing flow goes in front of its first step and feeds it.
    let feeds: string | undefined;
    if (mode === 'trigger' && state.nodes.length && !request.position) {
      const roots = state.nodes.filter(
        (n) =>
          state.nodeTypes[n.data.wf.type]?.descriptor.inputs.some((p) => p.type === 'main') &&
          !state.edges.some((e) => e.target === n.id && e.data?.connectionType === 'main'),
      );
      const first = roots.sort((a, b) => a.position.x - b.position.x)[0];
      if (first) {
        effective = { ...request, position: { x: first.position.x - 260, y: first.position.y } };
        feeds = first.id;
      }
    }
    const center = screenToFlowPosition({ x: window.innerWidth / 2 - 200, y: window.innerHeight / 2.3 });
    const id = state.placeNode(type.type, effective, { x: center.x - 44, y: center.y - 44 });
    if (!id) return;
    if (feeds) state.onConnect({ source: id, sourceHandle: 'main:0', target: feeds, targetHandle: 'main:0' });
    close();
    // Keep the new node in view.
    const node = useEditor.getState().nodes.find((n) => n.id === id);
    if (node) {
      const p = flowToScreenPosition(node.position);
      if (p.x < 200 || p.y < 100 || p.x > window.innerWidth - 300 || p.y > window.innerHeight - 260)
        setCenter(node.position.x + 44, node.position.y + 44, { zoom: getZoom(), duration: 450 });
    }
    if (type.descriptor.kind !== 'subnode' && type.descriptor.properties.length) setTimeout(() => useEditor.getState().openNode(id), 260);
  };

  /** Drop a frame of a composite type: where the panel was opened, else in the middle of the view. */
  const chooseComposite = (info: CompositeTypeInfo) => {
    if (!request) return;
    const center = screenToFlowPosition({ x: window.innerWidth / 2 - 360, y: window.innerHeight / 2.6 });
    const at = request.position ?? { x: center.x, y: center.y };
    const id = useEditor.getState().insertComposite(info.type, at);
    close();
    const frame = id && useEditor.getState().groups.find((g) => g.id === id);
    if (frame) setCenter(frame.position.x + (frame.width ?? 520) / 2, frame.position.y + (frame.height ?? 300) / 2, { zoom: getZoom(), duration: 450 });
  };

  const compositeRow = (info: CompositeTypeInfo): RowItem => {
    const color = info.descriptor.color ?? CATEGORY_COLOR.Core;
    return {
      key: `composite:${info.type}`,
      icon: (
        <IconBox color={color}>
          <NodeIcon icon={info.descriptor.icon ?? 'lucide:boxes'} size={18} style={{ color }} />
        </IconBox>
      ),
      title: (
        <span className="flex items-center gap-1.5">
          {info.descriptor.displayName}
          <span className="rounded-md border border-hair px-1 text-[10px] font-normal text-t3">composite</span>
        </span>
      ),
      description: info.descriptor.description || `Slots: ${info.descriptor.slots.map((x) => x.displayName).join(', ')}`,
      meta: <span className="font-mono text-[10px] text-t3">{info.source.kind === 'local' ? 'saved here' : info.source.pluginName}</span>,
      disabled: !info.available,
      onSelect: () => chooseComposite(info),
    };
  };

  const nodeRow = (t: NodeTypeInfo, override?: { title: string; description: string }): RowItem => {
    const lang = languageMeta(t.language);
    const color = nodeColor(t);
    return {
      key: t.type,
      icon: (
        <IconBox color={color} round={t.descriptor.kind === 'subnode'} image={isImage(t.descriptor.icon)}>
          <NodeIcon icon={t.descriptor.icon} size={isImage(t.descriptor.icon) ? 34 : 18} style={{ color }} strokeWidth={1.8} />
        </IconBox>
      ),
      title: (
        <span className="flex items-center gap-1.5">
          {override?.title ?? t.descriptor.displayName}
          {t.descriptor.usableAsTool && mode !== 'ai_tool' && <span className="rounded-md border border-hair px-1 text-[10px] font-normal text-t3">tool</span>}
        </span>
      ),
      description: override?.description ?? t.descriptor.description,
      meta:
        t.pluginId !== 'core' ? (
          <DevOnly>
            <span className="flex items-center gap-1 font-mono text-[10px] text-t3">
              <span className="size-1.5 rounded-full" style={{ background: lang.color }} />
              {lang.short}
            </span>
          </DevOnly>
        ) : undefined,
      disabled: !t.available,
      onSelect: () => choose(t),
    };
  };

  const segmentRow = (seg: Segment, count: number): RowItem => {
    const lang = languageMeta(seg.language);
    return {
      key: `plugin:${seg.pluginId}`,
      icon: (
        <IconBox color={seg.color} image={isImage(seg.icon)}>
          <PluginIcon segment={seg} size={isImage(seg.icon) ? 34 : 24} />
        </IconBox>
      ),
      title: (
        <span className="flex items-center gap-1.5">
          {seg.name}
          <span className={cn('size-1.5 rounded-full', seg.online ? 'bg-gn' : 'bg-bd')} title={seg.online ? 'Online' : 'Offline'} />
        </span>
      ),
      description: seg.description ?? `${count} node${count === 1 ? '' : 's'}`,
      meta: (
        <DevOnly>
          <span className="flex items-center gap-1 font-mono text-[10px] text-t3">
            <span className="size-1.5 rounded-full" style={{ background: lang.color }} />
            {lang.short} · {TRANSPORT_META[seg.transport].label}
          </span>
        </DevOnly>
      ),
      nav: true,
      onSelect: () => push({ kind: 'plugin', pluginId: seg.pluginId }),
    };
  };

  // ------------------------------------------------------------ view model
  const { title, subtitle, header, sections } = useMemo(() => {
    type Section = { label?: string; rows: RowItem[] };
    const out: { title: string; subtitle?: string; header?: ReactNode; sections: Section[] } = { title: '', sections: [] };
    if (!mode) return out;
    if (slot) {
      // A composite's slot: what it accepts, triggers aside.
      const accepted = all.filter((t) => t.descriptor.kind !== 'trigger' && nodeMatches(t.type, t.descriptor, slot.accepts));
      const shown = query.trim() ? accepted.filter((t) => score(searchText(t), query) > 0) : accepted;
      out.title = `Add to ${slot.displayName}`;
      out.subtitle = `Takes ${describeMatcher(slot.accepts)}`;
      const core = shown.filter((t) => t.pluginId === 'core');
      if (core.length) out.sections.push({ label: 'Built-in', rows: core.map((t) => nodeRow(t)) });
      for (const seg of segments) {
        const rows = shown.filter((t) => t.pluginId === seg.pluginId).map((t) => nodeRow(t));
        if (rows.length) out.sections.push({ label: seg.name, rows });
      }
      if (!shown.length) out.sections.push({ rows: [] });
      return out;
    }
    const pool = all.filter((t) => fits(t, mode));

    if (query.trim()) {
      const within = view.kind === 'plugin' ? pool.filter((t) => t.pluginId === view.pluginId) : pool;
      const hits = within
        .map((t) => ({ t, s: score(searchText(t), query) }))
        .filter((h) => h.s > 0)
        .sort((a, b) => b.s - a.s || a.t.descriptor.displayName.localeCompare(b.t.descriptor.displayName));
      const groups = new Map<string, RowItem[]>();
      for (const { t } of hits) {
        const group = t.pluginId === 'core' ? (t.descriptor.kind === 'trigger' ? 'Triggers' : (t.descriptor.categories?.[0] ?? 'Core')) : t.pluginName;
        groups.set(group, [...(groups.get(group) ?? []), nodeRow(t, mode === 'trigger' ? TRIGGER_TITLES[t.type] : undefined)]);
      }
      out.title = mode === 'trigger' ? 'What triggers this workflow?' : 'Search results';
      out.sections = [...groups.entries()].map(([label, rows]) => ({ label, rows }));
      if (mode === 'next' && view.kind !== 'plugin') {
        const found = composites.filter((c) => score(`${c.descriptor.displayName} ${c.descriptor.description} ${c.type} composite`, query) > 0);
        if (found.length) out.sections.unshift({ label: 'Composites', rows: found.map(compositeRow) });
      }
      return out;
    }

    if (view.kind === 'plugin') {
      const seg = segments.find((s) => s.pluginId === view.pluginId);
      if (!seg) return out;
      const types = seg.types.filter((t) => fits(t, mode === 'next' ? 'next' : mode));
      const lang = languageMeta(seg.language);
      out.title = seg.name;
      out.header = (
        <div className="flex items-center gap-3">
          <IconBox color={seg.color} image={isImage(seg.icon)}>
            <PluginIcon segment={seg} size={isImage(seg.icon) ? 38 : 24} />
          </IconBox>
          <div className="min-w-0">
            <div className="truncate text-[17px] font-semibold text-t1">{seg.name}</div>
            <div className="flex items-center gap-1.5 font-mono text-[11px] text-t3">
              <DevOnly>
                <span className="size-1.5 rounded-full" style={{ background: lang.color }} />
                {lang.label} · {TRANSPORT_META[seg.transport].label} ·{' '}
              </DevOnly>
              {seg.online ? 'online' : 'offline'}
            </div>
          </div>
        </div>
      );
      out.subtitle = seg.description;
      const byGroup = new Map<string, NodeTypeInfo[]>();
      for (const t of types.filter((t) => t.descriptor.kind !== 'trigger')) {
        const group = t.descriptor.categories?.[0] ?? 'Actions';
        byGroup.set(group, [...(byGroup.get(group) ?? []), t]);
      }
      const triggers = types.filter((t) => t.descriptor.kind === 'trigger');
      if (triggers.length) out.sections.push({ label: `Triggers (${triggers.length})`, rows: triggers.map((t) => nodeRow(t)) });
      for (const [group, list] of byGroup) out.sections.push({ label: `${group} (${list.length})`, rows: list.map((t) => nodeRow(t)) });
      if (!types.length) out.sections.push({ rows: [] });
      return out;
    }

    if (mode === 'trigger' || view.kind === 'triggers') {
      out.title = 'What triggers this workflow?';
      out.subtitle = 'A trigger is the step that starts your workflow';
      const triggers = all.filter((t) => t.descriptor.kind === 'trigger');
      const core = triggers
        .filter((t) => t.pluginId === 'core')
        .sort((a, b) => Object.keys(TRIGGER_TITLES).indexOf(a.type) - Object.keys(TRIGGER_TITLES).indexOf(b.type));
      out.sections.push({ rows: core.map((t) => nodeRow(t, TRIGGER_TITLES[t.type])) });
      const withTriggers = segments.filter((s) => s.types.some((t) => t.descriptor.kind === 'trigger'));
      if (withTriggers.length)
        out.sections.push({
          label: 'On a plugin event',
          rows: withTriggers.map((s) => segmentRow(s, s.types.filter((t) => t.descriptor.kind === 'trigger').length)),
        });
      return out;
    }

    if (mode !== 'next') {
      out.title = SUBNODE_TITLES[mode];
      out.subtitle = mode === 'ai_tool' ? 'Any node marked as a tool works, in any language: the agent calls it through its plugin' : undefined;
      const core = pool.filter((t) => t.pluginId === 'core');
      if (core.length) out.sections.push({ label: 'Built-in', rows: core.map((t) => nodeRow(t)) });
      for (const seg of segments) {
        const rows = pool.filter((t) => t.pluginId === seg.pluginId).map((t) => nodeRow(t));
        if (rows.length) out.sections.push({ label: seg.name, rows });
      }
      return out;
    }

    if (view.kind === 'category') {
      const cat = CATEGORIES.find((c) => c.key === view.key)!;
      out.title = cat.title;
      out.subtitle = cat.description;
      out.header = (
        <div className="flex items-center gap-3">
          <IconBox color={CATEGORY_COLOR[cat.key]}>
            <NodeIcon icon={cat.icon} size={18} style={{ color: CATEGORY_COLOR[cat.key] }} />
          </IconBox>
          <div className="text-[17px] font-semibold text-t1">{cat.title}</div>
        </div>
      );
      const types = pool.filter(cat.match);
      if (cat.key === 'AI') {
        const core = types.filter((t) => t.pluginId === 'core');
        // Roots take sub-nodes (a model, memory, tools); the rest call a model directly.
        const inCategory = (t: NodeTypeInfo, category: string) => Boolean(t.descriptor.categories?.includes(category));
        const stores = core.filter((t) => inCategory(t, 'Vector Stores'));
        const guards = core.filter((t) => inCategory(t, 'Guardrails'));
        const roots = core.filter((t) => t.descriptor.inputs.some((p) => p.type !== 'main') && !stores.includes(t) && !guards.includes(t));
        const actions = core.filter((t) => !roots.includes(t) && !stores.includes(t) && !guards.includes(t));
        const plugins = types.filter((t) => t.pluginId !== 'core');
        if (roots.length) out.sections.push({ label: 'Agents and chains', rows: roots.map((t) => nodeRow(t)) });
        if (stores.length) out.sections.push({ label: 'Retrieval (RAG): vector stores', rows: stores.map((t) => nodeRow(t)) });
        if (guards.length) out.sections.push({ label: 'Guardrails', rows: guards.map((t) => nodeRow(t)) });
        if (actions.length) out.sections.push({ label: 'Model actions', rows: actions.map((t) => nodeRow(t)) });
        if (plugins.length) out.sections.push({ label: 'From plugins', rows: plugins.map((t) => nodeRow(t)) });
        out.sections.push({ label: 'Models, memory and tools', rows: [] });
      } else out.sections.push({ rows: types.map((t) => nodeRow(t)) });
      return out;
    }

    // Root of "What happens next?"
    out.title = 'What happens next?';
    out.sections.push({
      rows: CATEGORIES.filter((c) => pool.some(c.match)).map((c) => ({
        key: `cat:${c.key}`,
        icon: (
          <IconBox color={CATEGORY_COLOR[c.key]}>
            <NodeIcon icon={c.icon} size={18} style={{ color: CATEGORY_COLOR[c.key] }} />
          </IconBox>
        ),
        title: c.title,
        description: c.description,
        nav: true,
        onSelect: () => push({ kind: 'category', key: c.key }),
      })),
    });
    const withActions = segments.map((s) => ({ s, n: s.types.filter((t) => fits(t, 'next')).length })).filter((x) => x.n);
    if (withActions.length) out.sections.push({ label: 'Plugins', rows: withActions.map(({ s, n }) => segmentRow(s, n)) });
    // Composite types: a frame of steps with a contract (its slots, rules and outputs), from plugins or saved here.
    if (composites.length) out.sections.push({ label: 'Composites', rows: composites.map(compositeRow) });
    out.sections.push({
      rows: [
        {
          key: 'triggers',
          icon: (
            <IconBox color={CATEGORY_COLOR.Triggers}>
              <Zap className="size-4" style={{ color: CATEGORY_COLOR.Triggers }} fill="currentColor" strokeWidth={0} />
            </IconBox>
          ),
          title: 'Add another trigger',
          description: 'Workflows can start in more than one way',
          nav: true,
          onSelect: () => push({ kind: 'triggers' }),
        },
      ],
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, all, segments, view, query, composites, slot]);

  const rows = sections.flatMap((s) => s.rows);

  // A search with no results that stays put is a missing node: tell the second brain once per query.
  const empty = rows.length === 0;
  useEffect(() => {
    const q = query.trim();
    if (!request || !empty || q.length < 3 || reported.current.has(q)) return;
    const timer = setTimeout(() => {
      reported.current.add(q);
      const workflowId = useEditor.getState().workflowId || undefined;
      api('/api/usage/signal', { method: 'POST', json: { kind: 'search.empty', query: q.slice(0, 300), workflowId } }).catch(() => {});
    }, 1500);
    return () => clearTimeout(timer);
  }, [request, empty, query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  useDialogFocus(creator, phone && Boolean(request && mode));
  if (!request || !mode) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[active];
      if (row && !row.disabled) row.onSelect();
    } else if (e.key === 'ArrowRight' && rows[active]?.nav && !query) {
      e.preventDefault();
      rows[active].onSelect();
    } else if ((e.key === 'ArrowLeft' || e.key === 'Backspace') && !query && stack.length > 1) {
      e.preventDefault();
      pop();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (query) setQuery('');
      else close();
    }
  };

  const placeholder =
    view.kind === 'plugin' ? `Search ${segments.find((s) => s.pluginId === view.pluginId)?.name ?? ''} nodes…` : 'Search nodes, plugins, languages…';
  let index = -1;

  return (
    <aside
      ref={creator}
      role={phone ? 'dialog' : undefined}
      aria-modal={phone || undefined}
      aria-label={phone ? 'Add a step' : undefined}
      className="absolute bottom-0 right-0 top-0 z-30 flex w-[384px] animate-panel flex-col border-l border-hair bg-sf shadow-[-12px_0_32px_rgba(0,0,0,0.06)] max-md:fixed max-md:inset-0 max-md:z-40 max-md:w-auto max-md:border-l-0 max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)]"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="shrink-0 px-5 pb-3 pt-4">
        <div className="flex items-start gap-2">
          {stack.length > 1 && (
            <button
              onClick={pop}
              aria-label="Back"
              className="-ml-1.5 mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-t2 hover:bg-acdim hover:text-t1 max-md:-mt-2 max-md:size-11"
            >
              <ArrowLeft className="size-4" />
            </button>
          )}
          <div key={`${stack.length}-${title}`} className={cn('min-w-0 flex-1', direction === 'push' ? 'animate-slide-left' : 'animate-slide-right')}>
            {header ?? <h2 className="text-[18px] font-semibold leading-tight text-t1">{title}</h2>}
            {subtitle && <p className="mt-1 text-[13px] leading-snug text-t2">{subtitle}</p>}
          </div>
          <button
            onClick={close}
            aria-label="Close"
            className="-mr-1.5 grid size-7 shrink-0 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1 max-md:-mt-2 max-md:size-11"
          >
            <X className="size-4" />
          </button>
        </div>
        <label className="mt-3 flex h-10 items-center gap-2 rounded-xl border border-bd bg-sf px-3 transition-shadow focus-within:border-ac focus-within:shadow-[0_0_0_3px_var(--acdim)]">
          <Search className="size-4 text-t3" />
          <input
            ref={input}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-t1 outline-none placeholder:text-t3"
          />
          {query && (
            <button onClick={() => setQuery('')} aria-label="Clear search" className="text-t3 hover:text-t1">
              <X className="size-3.5" />
            </button>
          )}
        </label>
      </div>

      <div
        ref={list}
        key={`${stack.length}-${view.kind}-${query ? 'q' : ''}`}
        className={cn('min-h-0 flex-1 overflow-y-auto px-2.5 pb-3', direction === 'push' ? 'animate-slide-left' : 'animate-slide-right')}
      >
        {rows.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <Puzzle className="size-6 text-t3" />
            <p className="text-[13px] text-t2">{query ? `Nothing matches “${query}”.` : 'Nothing here yet.'}</p>
            <p className="text-[12px] text-t3">Start a plugin and its nodes appear here automatically.</p>
          </div>
        )}
        {sections.map((section, si) => (
          <div key={si} className={cn(si > 0 && 'mt-2 border-t border-hair pt-2')}>
            {section.label && <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{section.label}</div>}
            {section.label === 'Models, memory and tools' && section.rows.length === 0 && (
              <p className="px-2.5 pb-2 text-[12px] leading-snug text-t3">Add these from an agent&apos;s ports: the + under Model, Memory or Tool. Embeddings, document loaders, text splitters and rerankers come from a vector store&apos;s ports.</p>
            )}
            {section.rows.map((row) => {
              index += 1;
              const i = index;
              return (
                <button
                  key={row.key}
                  data-index={i}
                  disabled={row.disabled}
                  onMouseEnter={() => setActive(i)}
                  onClick={row.onSelect}
                  style={{ animationDelay: `${Math.min(i, 14) * 16}ms` }}
                  className={cn(
                    'group relative flex w-full animate-fade-up items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                    i === active && 'bg-acdim',
                  )}
                >
                  {i === active && <span className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-ac" />}
                  {row.icon}
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-semibold text-t1">{row.title}</span>
                    {row.description && <span className="line-clamp-2 block text-[12px] leading-snug text-t3">{row.description}</span>}
                  </span>
                  {row.meta}
                  {row.nav ? (
                    <ChevronRight className="size-4 shrink-0 text-t3 transition-transform group-hover:translate-x-0.5" />
                  ) : (
                    i === active && <ArrowRight className="size-3.5 shrink-0 text-t3" />
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-3 border-t border-hair px-5 py-2 text-[11px] text-t3">
        <span className="flex items-center gap-1">
          <Kbd>↑↓</Kbd> move
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd> add
        </span>
        <span className="flex items-center gap-1">
          <Kbd>←</Kbd> back
        </span>
        <span className="ml-auto">
          {all.length} nodes · {segments.length + 1} plugins
        </span>
      </div>
    </aside>
  );
}
