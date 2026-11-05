'use client';
/**
 * Abilities tab → Model router: send short, simple requests to a cheaper model and keep the agent's own model for the rest.
 * The cheap model is any model the agent could use, so a local Ollama model or an OpenAI-compatible gateway both work.
 */
import { Route } from 'lucide-react';
import { DEFAULT_ROUTER, ROUTER_MAX_CHARS_LIMIT, type AgentRouter } from '@/lib/shared/agent-router';
import type { AgentConfig, AgentModel } from '@/lib/shared/agents';
import { Input, Select } from '../ui/inputs';
import { Field, Section, ToggleRow } from './dialog';
import { LayerStatsLine } from './layer-stats-line';
import { ModelPicker } from './model-card';
import { DEFAULT_OLLAMA_URL, PROVIDERS, type UpdateConfig } from './util';

export function RouterCard({ agentId, config, update }: { agentId: string; config: AgentConfig; update: UpdateConfig }) {
  const router: AgentRouter = config.router ?? DEFAULT_ROUTER;
  const set = (patch: Partial<AgentRouter>) => update((c) => ({ ...c, router: { ...(c.router ?? DEFAULT_ROUTER), ...patch } }));
  const cheap = router.cheapModel;
  const agentModel = config.model;

  /** A cheap model on the agent's own provider reuses its credential; Ollama needs only a server. */
  const setProvider = (provider: AgentModel['provider']) =>
    set({
      cheapModel: {
        provider,
        model: '',
        ...(provider === 'ollama' ? { baseUrl: agentModel?.provider === 'ollama' && agentModel.baseUrl ? agentModel.baseUrl : DEFAULT_OLLAMA_URL } : {}),
        ...(provider === agentModel?.provider && agentModel.credential ? { credential: agentModel.credential } : {}),
      },
    });

  return (
    <Section
      icon={<Route className="size-4" />}
      title="Model router"
      description="Send short, simple requests to a cheaper model. Everything else, and every resumed run, uses this agent's own model."
    >
      <div className="space-y-3">
        <ToggleRow
          title="Route easy requests to a cheaper model"
          description="The session shows each time it did, and why."
          checked={router.mode === 'auto'}
          onChange={(on) => set({ mode: on ? 'auto' : 'fixed' })}
        />
        {router.mode === 'auto' && (
          <>
            <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
              <Field id="router-provider" label="Cheap model from">
                <Select id="router-provider" value={cheap?.provider ?? ''} onChange={(e) => setProvider(e.target.value as AgentModel['provider'])}>
                  <option value="" disabled>
                    Choose…
                  </option>
                  {PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </Field>
              {cheap && <ModelPicker model={cheap} onChange={(patch) => set({ cheapModel: { ...cheap, ...patch } })} />}
            </div>
            <Field id="router-max" label="Easy means at most this many characters" hint={`Longer requests use the agent's own model (up to ${ROUTER_MAX_CHARS_LIMIT.toLocaleString()}).`}>
              <Input id="router-max" type="number" min={20} max={ROUTER_MAX_CHARS_LIMIT} value={router.maxChars} onChange={(e) => set({ maxChars: Number(e.target.value) || DEFAULT_ROUTER.maxChars })} />
            </Field>
            <ToggleRow
              title="Also when the agent has tools"
              description="Off by default: a small model calls tools less reliably."
              checked={router.allowTools}
              onChange={(on) => set({ allowTools: on })}
            />
            {!cheap?.model && <p className="text-[12px] text-t3">Choose the cheap model to switch routing on.</p>}
          </>
        )}
        <LayerStatsLine agentId={agentId} kind="routed" />
      </div>
    </Section>
  );
}
