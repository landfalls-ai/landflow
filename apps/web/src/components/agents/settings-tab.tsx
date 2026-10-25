'use client';
/** The Settings tab: limits of the agent loop, and usage limits (tokens and estimated cost) with what the agent used so far. */
import { useEffect, useState } from 'react';
import { CircleDollarSign, Gauge } from 'lucide-react';
import { DEFAULT_AGENT_SETTINGS, type AgentConfig, type AgentSettings } from '@/lib/shared/agents';
import { formatCost, formatTokens, type AiUsageReport, type AiUsageTotals } from '@/lib/shared/ai-usage';
import { api } from '@/lib/client/api';
import { Input } from '../ui/inputs';
import { Field, Section } from './dialog';
import type { UpdateConfig } from './util';

type LoopKey = Exclude<keyof AgentSettings, UsageKey>;
type UsageKey = 'dailyTokenLimit' | 'dailyCostLimit' | 'monthlyCostLimit';

const FIELDS: Array<{
  key: LoopKey;
  label: string;
  hint: string;
  min: number;
  max: number;
  suffix?: string;
}> = [
  {
    key: 'maxIterations',
    label: 'Max iterations',
    hint: 'Model turns per run before the agent stops (1–200).',
    min: 1,
    max: 200,
  },
  {
    key: 'toolConcurrency',
    label: 'Tool concurrency',
    hint: 'Tool calls of one turn that run at the same time (1–20).',
    min: 1,
    max: 20,
  },
  {
    key: 'sessionTokenBudget',
    label: 'Session token budget',
    hint: 'Stop a session once it used this many tokens. 0 means no cap.',
    min: 0,
    max: 100_000_000,
    suffix: 'tokens',
  },
  {
    key: 'maxDelegationDepth',
    label: 'Max delegation depth',
    hint: 'How many levels of sub-agents may delegate further (1–5).',
    min: 1,
    max: 5,
  },
];

/** Usage limits across all sessions; 0 means no cap. Costs are estimated from Settings → AI prices. */
const USAGE_FIELDS: Array<{ key: UsageKey; label: string; hint: string; max: number; decimals: number; prefix?: string; suffix?: string }> = [
  { key: 'dailyTokenLimit', label: 'Tokens per day', hint: 'Input and output tokens across all sessions, per day. 0 means no cap.', max: 1_000_000_000, decimals: 0, suffix: 'tokens' },
  { key: 'dailyCostLimit', label: 'Cost per day', hint: 'Estimated cost per day. 0 means no cap.', max: 1_000_000, decimals: 2, prefix: '$', suffix: 'USD' },
  { key: 'monthlyCostLimit', label: 'Cost per month', hint: 'Estimated cost per calendar month. 0 means no cap.', max: 10_000_000, decimals: 2, prefix: '$', suffix: 'USD' },
];

/** A number input that keeps what is typed and clamps on blur (rounded to `decimals`). */
function NumberSetting({ id, value, min, max, decimals = 0, onChange }: { id: string; value: number; min: number; max: number; decimals?: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(text) * 10 ** decimals) / 10 ** decimals;
    const clamped = Number.isFinite(n) && text.trim() !== '' ? Math.min(max, Math.max(min, n)) : value;
    setText(String(clamped));
    if (clamped !== value) onChange(clamped);
  };
  return (
    <Input
      id={id}
      type="number"
      inputMode={decimals ? 'decimal' : 'numeric'}
      step={decimals ? 1 / 10 ** decimals : 1}
      min={min}
      max={max}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      className="w-36 tabular-nums"
    />
  );
}

/** Used today and this month against the caps (GET /api/insights/ai-usage?agentId=). */
function UsageSummary({ agentId, settings }: { agentId: string; settings: AgentSettings }) {
  const [report, setReport] = useState<AiUsageReport>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api<AiUsageReport>(`/api/insights/ai-usage?agentId=${encodeURIComponent(agentId)}&days=31`)
      .then(setReport)
      .catch(() => setFailed(true));
  }, [agentId]);
  if (failed) return null;
  const tile = (label: string, value: string, detail: string, cap?: string) => (
    <div className="rounded-[10px] border border-hair bg-wl px-3 py-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-t3">{label}</div>
      <div className="mt-1 font-mono text-[15px] font-semibold tabular-nums text-t1">{value}</div>
      <div className="mt-0.5 truncate text-[12px] text-t3" title={detail}>
        {detail}
        {cap && <span> · cap {cap}</span>}
      </div>
    </div>
  );
  const totals = (t: AiUsageTotals | undefined) => t ?? { inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 };
  const today = totals(report?.today);
  const month = totals(report?.month);
  const tokens = (t: AiUsageTotals) => `${formatTokens(t.inputTokens + t.outputTokens)} tokens · ${t.calls.toLocaleString()} call${t.calls === 1 ? '' : 's'}`;
  if (!report) return <div className="mb-4 h-[70px] rounded-[10px] bg-acdim animate-pulse-soft" />;
  return (
    <div className="mb-4 grid gap-2 sm:grid-cols-3">
      {tile('Tokens today', formatTokens(today.inputTokens + today.outputTokens), `${today.calls.toLocaleString()} model call${today.calls === 1 ? '' : 's'}`, settings.dailyTokenLimit ? formatTokens(settings.dailyTokenLimit) : undefined)}
      {tile('Cost today', formatCost(today.cost), tokens(today), settings.dailyCostLimit ? formatCost(settings.dailyCostLimit) : undefined)}
      {tile('Cost this month', formatCost(month.cost), tokens(month), settings.monthlyCostLimit ? formatCost(settings.monthlyCostLimit) : undefined)}
    </div>
  );
}

export function SettingsTab({ config, update, agentId }: { config: AgentConfig; update: UpdateConfig; agentId?: string }) {
  return (
    <div className="space-y-4">
      <Section icon={<Gauge className="size-4" />} title="Limits" description="Guardrails for how long and how widely the agent works on one request.">
        <div className="grid gap-5 sm:grid-cols-2">
          {FIELDS.map((field) => (
            <Field
              key={field.key}
              id={`setting-${field.key}`}
              label={field.label}
              hint={field.hint}
              aside={config.settings[field.key] !== DEFAULT_AGENT_SETTINGS[field.key] ? `default ${DEFAULT_AGENT_SETTINGS[field.key]}` : undefined}
            >
              <div className="flex items-center gap-2">
                <NumberSetting
                  id={`setting-${field.key}`}
                  value={config.settings[field.key]}
                  min={field.min}
                  max={field.max}
                  onChange={(v) =>
                    update((c) => ({
                      ...c,
                      settings: { ...c.settings, [field.key]: v },
                    }))
                  }
                />
                {field.suffix && <span className="text-[12px] text-t3">{field.suffix}</span>}
              </div>
            </Field>
          ))}
        </div>
      </Section>
      <Section
        icon={<CircleDollarSign className="size-4" />}
        title="Usage limits"
        description="Caps on what the agent spends across all sessions (instance time zone). A run that reaches one stops with a notice, and new runs are refused until the day or month is over."
      >
        {agentId && <UsageSummary agentId={agentId} settings={config.settings} />}
        <div className="grid gap-5 sm:grid-cols-3">
          {USAGE_FIELDS.map((field) => (
            <Field key={field.key} id={`setting-${field.key}`} label={field.label} hint={field.hint}>
              <div className="flex items-center gap-2">
                {field.prefix && <span className="text-[12px] text-t3">{field.prefix}</span>}
                <NumberSetting
                  id={`setting-${field.key}`}
                  value={config.settings[field.key] ?? 0}
                  min={0}
                  max={field.max}
                  decimals={field.decimals}
                  onChange={(v) => update((c) => ({ ...c, settings: { ...c.settings, [field.key]: v } }))}
                />
                {field.suffix && <span className="text-[12px] text-t3">{field.suffix}</span>}
              </div>
            </Field>
          ))}
        </div>
        <p className="mt-3 text-[12px] leading-snug text-t3">Costs are estimates from the price table in Settings → AI prices; local models such as Ollama count as free unless priced there.</p>
      </Section>
    </div>
  );
}
