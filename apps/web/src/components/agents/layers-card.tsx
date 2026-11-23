'use client';
/**
 * Abilities tab navigation: one row per layer around the model (docs/agents.md "Abilities"). A row says what is set; clicking it
 * opens its card in place. The rows hold the cards, so there is no second list of the same things below.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { agentLayers, type Layer, type LayerState } from '@/lib/shared/agent-layers';
import type { AgentConfig } from '@/lib/shared/agents';
import { ABILITY_LABEL, type AbilityRow } from './tabs';

/** What each row's line says and whether it counts as set up, from the layers and the config. */
export function rowSummary(row: AbilityRow, config: AgentConfig, layers: Layer[], published: boolean, kagent?: { name: string } | null): { state: LayerState; detail: string } {
  const layer = (id: Layer['id']) => layers.find((l) => l.id === id);
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  switch (row) {
    case 'model': {
      const model = config.model;
      return model?.model ? { state: 'done', detail: `${model.provider} · ${model.model}` } : { state: 'todo', detail: 'Choose the model that answers.' };
    }
    case 'capabilities': {
      const knowledge = config.tools.filter((t) => t.type === 'knowledge').length;
      const tools = config.tools.length - knowledge;
      const plugins = config.plugins?.length ?? 0;
      const skills = config.skills.length;
      const bits = [
        tools ? plural(tools, 'tool') : '',
        knowledge ? plural(knowledge, 'knowledge base', 'knowledge bases') : '',
        skills ? plural(skills, 'skill') : '',
        plugins ? plural(plugins, 'plugin') : '',
      ].filter(Boolean);
      return bits.length ? { state: 'done', detail: bits.join(' · ') } : { state: 'todo', detail: 'Tools, knowledge, skills and plugins. Without them the agent can only talk.' };
    }
    case 'triggers': {
      const bits = [
        config.schedules.length ? plural(config.schedules.length, 'schedule') : '',
        config.channels.length ? plural(config.channels.length, 'channel') : '',
      ].filter(Boolean);
      return bits.length ? { state: 'done', detail: bits.join(' · ') } : { state: 'todo', detail: 'Run on a schedule or let people message it.' };
    }
    case 'guardrails': {
      const g = layer('guardrails');
      return { state: g?.state ?? 'todo', detail: g?.detail ?? '' };
    }
    case 'deploy':
      return kagent
        ? { state: 'done', detail: `On kagent · ${kagent.name}` }
        : { state: 'todo', detail: published ? 'Not deployed. Run it on a kagent cluster.' : 'Not deployed. Publish first, then run it on a kagent cluster.' };
    case 'advanced': {
      const on = (['router', 'cache', 'access'] as const).filter((id) => layer(id)?.state === 'done').length;
      return { state: on ? 'done' : 'todo', detail: `Router, cache and tool access${on ? ` · ${on} on` : ''}` };
    }
  }
}

export function LayersCard({
  agentId,
  config,
  rows,
  open,
  onToggle,
  published,
  kagent,
  children,
}: {
  agentId: string;
  config: AgentConfig;
  rows: AbilityRow[];
  open: ReadonlySet<AbilityRow>;
  onToggle: (row: AbilityRow) => void;
  published: boolean;
  /** The agent's kagent deployment, if any. */
  kagent?: { name: string } | null;
  /** The card each row opens. */
  children: (row: AbilityRow) => ReactNode;
}) {
  const [evalCases, setEvalCases] = useState(0);
  useEffect(() => {
    api<{ cases: unknown[] }>(`/api/agents/${agentId}/eval-gate`)
      .then((r) => setEvalCases(r.cases.length))
      .catch(() => setEvalCases(0));
  }, [agentId]);

  const layers = agentLayers(config, { evalCases });
  const summaries = rows.map((row) => rowSummary(row, config, layers, published, kagent));
  const done = summaries.filter((r) => r.state === 'done').length;

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-t3" aria-live="polite">
        {done} of {rows.length} set up. Open a row to change it.
      </p>
      {rows.map((row, i) => {
        const { state, detail } = summaries[i];
        const isOpen = open.has(row);
        return (
          <section key={row} id={`row-${row}`} className="scroll-mt-20 rounded-2xl border border-hair bg-sf">
            <button
              type="button"
              aria-expanded={isOpen}
              aria-controls={`panel-${row}`}
              onClick={() => onToggle(row)}
              className="flex min-h-11 w-full items-center gap-3 rounded-2xl px-4 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-ac"
            >
              <span aria-hidden="true" className={cn('flex size-5 shrink-0 items-center justify-center rounded-full', state === 'done' ? 'bg-gndim text-gn' : 'bg-acdim text-t3')}>
                {state === 'done' ? <Check className="size-3" /> : state === 'na' ? <Minus className="size-3" /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-semibold text-t1">
                  {ABILITY_LABEL[row]}
                  <span className="sr-only">{state === 'done' ? ' (set up)' : ' (not set up)'}</span>
                </span>
                <span className="block truncate text-[12px] text-t3">{detail}</span>
              </span>
              <ChevronDown className={cn('size-4 shrink-0 text-t3 transition-transform motion-reduce:transition-none', isOpen && 'rotate-180')} />
            </button>
            {isOpen && (
              <div id={`panel-${row}`} className="space-y-4 border-t border-hair p-3 max-md:p-2">
                {children(row)}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
