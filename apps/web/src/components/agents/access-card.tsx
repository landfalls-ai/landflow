'use client';
/**
 * Abilities tab → Tool access: which callers may use which tools. The first rule that matches the caller and the tool decides;
 * with no match a tool is allowed. An external policy engine (OPA, OpenFGA) can restrict further (docs/agents.md "Tool access").
 */
import { Plus, ShieldHalf, Trash2 } from 'lucide-react';
import { nanoid } from 'nanoid';
import { cleanAccess, type AccessEffect, type AccessRule } from '@/lib/shared/agent-access';
import type { AgentConfig, SessionSource } from '@/lib/shared/agents';
import { ROLES } from '@/lib/shared/auth';
import { Button } from '../ui/button';
import { Input, Select } from '../ui/inputs';
import { Section } from './dialog';
import type { UpdateConfig } from './util';

const SOURCES: Array<{ value: SessionSource; label: string }> = [
  { value: 'test', label: 'Test chat' },
  { value: 'schedule', label: 'A schedule' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'slack', label: 'Slack' },
  { value: 'teams', label: 'Teams' },
  { value: 'workflow', label: 'A workflow' },
  { value: 'agent', label: 'Another agent' },
  { value: 'api', label: 'The API' },
];

const EFFECTS: Array<{ value: AccessEffect; label: string }> = [
  { value: 'allow', label: 'may use it' },
  { value: 'ask', label: 'needs approval' },
  { value: 'deny', label: 'may not use it' },
];

export function AccessCard({ config, update }: { config: AgentConfig; update: UpdateConfig }) {
  const rules = config.access?.rules ?? [];
  const setRules = (next: AccessRule[]) => update((c) => {
    const { access: _access, ...rest } = c;
    const access = cleanAccess({ rules: next });
    return { ...rest, ...(access && { access }) };
  });
  const change = (id: string, patch: Partial<AccessRule>) => setRules(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const changeWho = (id: string, patch: Partial<AccessRule['who']>) => setRules(rules.map((r) => (r.id === id ? { ...r, who: { ...r.who, ...patch } } : r)));

  return (
    <Section
      icon={<ShieldHalf className="size-4" />}
      title="Tool access"
      description="Who may use which tool. The first rule that matches decides; a tool with no matching rule is allowed. A tool a caller may not use is never shown to the model."
    >
      <div className="space-y-3">
        {rules.map((rule, index) => (
          <div key={rule.id} className="space-y-2 rounded-[10px] border border-hair bg-wl p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-medium text-t3">Rule {index + 1}</span>
              <Button size="icon-sm" variant="ghost" aria-label={`Remove rule ${index + 1}`} onClick={() => setRules(rules.filter((r) => r.id !== rule.id))}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input aria-label="Tool name, or * for every tool" placeholder="Tool name, or * for every tool" value={rule.tool} onChange={(e) => change(rule.id, { tool: e.target.value })} />
              <Select aria-label="What happens" value={rule.effect} onChange={(e) => change(rule.id, { effect: e.target.value as AccessEffect })}>
                {EFFECTS.map((e) => (
                  <option key={e.value} value={e.value}>
                    {e.label}
                  </option>
                ))}
              </Select>
              <Select aria-label="For which role" value={rule.who.role ?? ''} onChange={(e) => changeWho(rule.id, { role: e.target.value || undefined })}>
                <option value="">Any role</option>
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </Select>
              <Select aria-label="Coming from" value={rule.who.source ?? ''} onChange={(e) => changeWho(rule.id, { source: (e.target.value || undefined) as SessionSource | undefined })}>
                <option value="">From anywhere</option>
                {SOURCES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </div>
            <Input aria-label="One user's id (optional)" placeholder="One user's id (optional)" value={rule.who.user ?? ''} onChange={(e) => changeWho(rule.id, { user: e.target.value || undefined })} />
          </div>
        ))}
        {!rules.length && <p className="text-[12px] text-t3">No rules: every caller may use every tool.</p>}
        <Button size="sm" variant="outline" onClick={() => setRules([...rules, { id: `rule_${nanoid(6)}`, tool: '*', who: {}, effect: 'ask' }])}>
          <Plus className="size-3.5" /> Add a rule
        </Button>
      </div>
    </Section>
  );
}
