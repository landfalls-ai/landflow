'use client';
/** The Settings tab: limits of the agent loop. */
import { useEffect, useState } from 'react';
import { Gauge } from 'lucide-react';
import { DEFAULT_AGENT_SETTINGS, type AgentConfig, type AgentSettings } from '@/lib/shared/agents';
import { Input } from '../ui/inputs';
import { Field, Section } from './dialog';
import type { UpdateConfig } from './util';

const FIELDS: Array<{
  key: keyof AgentSettings;
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

/** A number input that keeps what is typed and clamps on blur. */
function NumberSetting({ id, value, min, max, onChange }: { id: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(text));
    const clamped = Number.isFinite(n) && text.trim() !== '' ? Math.min(max, Math.max(min, n)) : value;
    setText(String(clamped));
    if (clamped !== value) onChange(clamped);
  };
  return (
    <Input
      id={id}
      type="number"
      inputMode="numeric"
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

export function SettingsTab({ config, update }: { config: AgentConfig; update: UpdateConfig }) {
  return (
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
  );
}
