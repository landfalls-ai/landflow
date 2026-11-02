'use client';
/**
 * What an actor works with (RunActor.connections): chips on the chart and the cards, a list in the actor's sheet. Each
 * shows the thing's own icon: its node type's (a plugin's logo), else its brand (Ollama, GitHub, kagent), else its kind's.
 */
import { cn } from '@/lib/utils';
import type { ActorConnection } from '@/lib/shared/run-trace';
import { useNodeTypes } from '../agents/use-agent-data';
import { NodeIcon } from '../ui/icon';

const KIND_ICON: Record<ActorConnection['kind'], string> = {
  runtime: 'lucide:server',
  model: 'lucide:cpu',
  memory: 'lucide:brain',
  knowledge: 'lucide:library',
  tool: 'lucide:wrench',
  skill: 'lucide:graduation-cap',
  agent: 'lucide:bot',
  plugin: 'lucide:puzzle',
  network: 'lucide:globe',
};

export const KIND_LABEL: Record<ActorConnection['kind'], string> = {
  runtime: 'Runs on',
  model: 'Model',
  memory: 'Memory',
  knowledge: 'Knowledge',
  tool: 'Tool',
  skill: 'Skill',
  agent: 'Can ask',
  plugin: 'Plugin',
  network: 'May reach',
};

const FROM: Record<NonNullable<ActorConnection['from']>, string> = { flow: 'in the flow', agent: 'in its settings', kagent: 'on kagent' };

/** The icon of a connection: its node type's, else its own, else its kind's. */
export function useConnectionIcon() {
  const nodeTypes = useNodeTypes();
  return (c: ActorConnection) => (c.nodeType && nodeTypes?.[c.nodeType]?.descriptor.icon) || c.icon || KIND_ICON[c.kind];
}

/** A row of chips, `max` at most (then "+N"). */
export function ConnectionChips({ connections, max = 8, className }: { connections?: ActorConnection[]; max?: number; className?: string }) {
  const iconOf = useConnectionIcon();
  if (!connections?.length) return null;
  const shown = connections.slice(0, max);
  return (
    <span className={cn('flex flex-wrap gap-1', className)} aria-label="Works with">
      {shown.map((c) => (
        <span
          key={`${c.kind}:${c.name}`}
          title={`${KIND_LABEL[c.kind]}: ${c.name}${c.detail ? ` · ${c.detail}` : ''}`}
          className="inline-flex max-w-[11rem] items-center gap-1 rounded-full border border-hair bg-sf2 py-0.5 pl-1 pr-2 text-[11px] leading-4 text-t2"
        >
          <NodeIcon icon={iconOf(c)} size={13} className="shrink-0 text-t2" />
          <span className="truncate">{c.name}</span>
        </span>
      ))}
      {connections.length > shown.length && <span className="inline-flex items-center rounded-full px-1.5 text-[11px] text-t3">+{connections.length - shown.length}</span>}
    </span>
  );
}

/** Every connection, one per row, by kind: in the actor's sheet. */
export function ConnectionList({ connections }: { connections: ActorConnection[] }) {
  const iconOf = useConnectionIcon();
  return (
    <ul className="divide-y divide-hair rounded-xl border border-hair">
      {connections.map((c) => (
        <li key={`${c.kind}:${c.name}`} className="flex items-center gap-2.5 px-3 py-2">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-hair bg-sf2">
            <NodeIcon icon={iconOf(c)} size={18} className="text-t1" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold text-t1">{c.name}</span>
            <span className="block truncate text-[11.5px] text-t3">
              {KIND_LABEL[c.kind]}
              {c.detail ? ` · ${c.detail}` : ''}
              {c.from ? ` · ${FROM[c.from]}` : ''}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The model an actor's usage names, with its provider's icon when its connections tell it. */
export function ModelMark({ connections, model }: { connections?: ActorConnection[]; model?: string }) {
  const iconOf = useConnectionIcon();
  const c = connections?.find((x) => x.kind === 'model' && (!model || x.name === model)) ?? connections?.find((x) => x.kind === 'model');
  if (!c) return null;
  return <NodeIcon icon={iconOf(c)} size={13} className="mr-1 inline-block shrink-0 align-[-2px] text-t2" />;
}
