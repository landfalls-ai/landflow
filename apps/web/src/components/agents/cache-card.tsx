'use client';
/**
 * Abilities tab → Response cache: a question asked again, word for word, gets the stored answer with no model call.
 * Only the first message of a session to an agent without tools or memory is cached (docs/agents.md "Response cache").
 */
import { useCallback, useEffect, useState } from 'react';
import { DatabaseZap } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { CACHE_TTL_DEFAULT, CACHE_TTL_MAX, CACHE_TTL_MIN, DEFAULT_SEMANTIC, SEMANTIC_THRESHOLD_MAX, SEMANTIC_THRESHOLD_MIN, type AgentCache, type SemanticCache } from '@/lib/shared/agent-cache';
import type { AgentConfig } from '@/lib/shared/agents';
import { Button } from '../ui/button';
import { Input, Select } from '../ui/inputs';
import { Field, Section, ToggleRow } from './dialog';
import { LayerStatsLine } from './layer-stats-line';
import type { UpdateConfig } from './util';

const UNITS = [
  { value: 60, label: 'minutes' },
  { value: 3_600, label: 'hours' },
  { value: 86_400, label: 'days' },
] as const;

/** The largest unit that divides the TTL evenly. */
function split(seconds: number): { amount: number; unit: number } {
  const unit = [...UNITS].reverse().find((u) => seconds % u.value === 0)?.value ?? 60;
  return { amount: Math.max(1, Math.round(seconds / unit)), unit };
}

export function CacheCard({ agentId, config, update }: { agentId: string; config: AgentConfig; update: UpdateConfig }) {
  const cache: AgentCache = config.cache ?? { enabled: false, ttlSeconds: CACHE_TTL_DEFAULT };
  const { amount, unit } = split(cache.ttlSeconds);
  const [stats, setStats] = useState<{ entries: number; hits: number }>();
  const semantic: SemanticCache = cache.semantic ?? DEFAULT_SEMANTIC;
  const setSemantic = (patch: Partial<SemanticCache>) => update((c) => ({ ...c, cache: { ...(c.cache ?? { enabled: true, ttlSeconds: CACHE_TTL_DEFAULT }), semantic: { ...(c.cache?.semantic ?? DEFAULT_SEMANTIC), ...patch } } }));
  const set = (patch: Partial<AgentCache>) => update((c) => ({ ...c, cache: { ...(c.cache ?? { enabled: false, ttlSeconds: CACHE_TTL_DEFAULT }), ...patch } }));
  const setTtl = (nextAmount: number, nextUnit: number) => set({ ttlSeconds: Math.min(CACHE_TTL_MAX, Math.max(CACHE_TTL_MIN, Math.round(nextAmount * nextUnit))) });

  const load = useCallback(() => {
    api<{ stats: { entries: number; hits: number } }>(`/api/agents/${agentId}/cache`)
      .then((r) => setStats(r.stats))
      .catch(() => setStats(undefined));
  }, [agentId]);
  useEffect(load, [load]);

  const clear = async () => {
    try {
      const { cleared } = await api<{ cleared: number }>(`/api/agents/${agentId}/cache`, { method: 'DELETE' });
      toast.success(cleared ? `Forgot ${cleared} answer${cleared === 1 ? '' : 's'}` : 'The cache was already empty');
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <Section
      icon={<DatabaseZap className="size-4" />}
      title="Response cache"
      description="A question asked again, word for word (or, if you switch it on, with the same meaning), gets the stored answer with no model call. Only the first message of a session is cached, and only for an agent without tools or cross-session memory. Editing the persona, model or guardrails starts a fresh cache."
    >
      <div className="space-y-3">
        <ToggleRow title="Answer repeated questions from the cache" description="Case and extra spaces are ignored." checked={cache.enabled} onChange={(on) => set({ enabled: on })} />
        {cache.enabled && (
          <div className="grid gap-3 sm:grid-cols-[120px_140px]">
            <Field id="cache-ttl" label="Keep an answer for">
              <Input id="cache-ttl" type="number" min={1} value={amount} onChange={(e) => setTtl(Number(e.target.value) || 1, unit)} />
            </Field>
            <Field id="cache-unit" label="Unit">
              <Select id="cache-unit" value={unit} onChange={(e) => setTtl(amount, Number(e.target.value))}>
                {UNITS.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        {cache.enabled && (
          <>
            <ToggleRow
              title="Also answer questions that mean the same"
              description="An embedding model compares a new question with the stored ones. Needs an Ollama embedding model (ollama pull nomic-embed-text)."
              checked={semantic.enabled}
              onChange={(on) => setSemantic({ enabled: on })}
            />
            {semantic.enabled && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="semantic-model" label="Embedding model">
                  <Input id="semantic-model" value={semantic.model} onChange={(e) => setSemantic({ model: e.target.value })} />
                </Field>
                <Field id="semantic-threshold" label="How alike (0.7 to 0.99)" hint="Higher is stricter: fewer answers reused, fewer wrong ones.">
                  <Input id="semantic-threshold" type="number" step={0.01} min={SEMANTIC_THRESHOLD_MIN} max={SEMANTIC_THRESHOLD_MAX} value={semantic.threshold} onChange={(e) => setSemantic({ threshold: Number(e.target.value) || DEFAULT_SEMANTIC.threshold })} />
                </Field>
              </div>
            )}
          </>
        )}
        <div className="flex items-center gap-3 text-[12px] text-t3">
          <span>{stats ? `${stats.entries} answer${stats.entries === 1 ? '' : 's'} kept, served again ${stats.hits} time${stats.hits === 1 ? '' : 's'}` : 'Counts unavailable'}</span>
          <Button size="sm" variant="outline" disabled={!stats?.entries} onClick={() => void clear()}>
            Clear
          </Button>
        </div>
        <LayerStatsLine agentId={agentId} kind="cached" />
      </div>
    </Section>
  );
}
