'use client';
/** Abilities tab → Layers: which of the layers around the model this agent has, each with a button to the setting that adds it. */
import { useEffect, useState } from 'react';
import { Check, Layers, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { agentLayers, layerScore, type Layer } from '@/lib/shared/agent-layers';
import type { AgentConfig } from '@/lib/shared/agents';
import { Button } from '../ui/button';
import { Section } from './dialog';

export function LayersCard({ agentId, config, onFix }: { agentId: string; config: AgentConfig; onFix: (fix: Layer['fix']) => void }) {
  const [evalCases, setEvalCases] = useState(0);
  useEffect(() => {
    api<{ cases: unknown[] }>(`/api/agents/${agentId}/eval-gate`)
      .then((r) => setEvalCases(r.cases.length))
      .catch(() => setEvalCases(0));
  }, [agentId]);

  const layers = agentLayers(config, { evalCases });
  const { done, total } = layerScore(layers);

  return (
    <Section icon={<Layers className="size-4" />} title={`Layers · ${done} of ${total}`} description="What surrounds this agent's model, in the order a request passes through. A layer that doesn't apply is greyed out.">
      <ul className="space-y-2">
        {layers.map((layer) => (
          <li key={layer.id} className={cn('flex items-start gap-3 rounded-[10px] border border-hair bg-wl px-3 py-2', layer.state === 'na' && 'opacity-60')}>
            <span
              aria-hidden="true"
              className={cn('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full', layer.state === 'done' ? 'bg-gndim text-gn' : 'bg-acdim text-t3')}
            >
              {layer.state === 'done' ? <Check className="size-3" /> : layer.state === 'na' ? <Minus className="size-3" /> : null}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-t1">
                {layer.label}
                <span className="sr-only">{layer.state === 'done' ? ' (set up)' : layer.state === 'na' ? ' (does not apply)' : ' (not set up)'}</span>
              </div>
              <div className="text-[12px] text-t3">{layer.detail}</div>
            </div>
            {layer.state === 'todo' && (
              <Button size="sm" variant="outline" onClick={() => onFix(layer.fix)}>
                Set up
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}
