'use client';
/**
 * Abilities tab → Tool access: which callers may use which tools. The first rule that matches the caller and the tool decides;
 * with no match a tool is allowed. An external policy engine (OPA, OpenFGA) can restrict further (docs/agents.md "Tool access").
 */
import { useState } from 'react';
import { Plus, ShieldHalf, Trash2 } from 'lucide-react';
import { nanoid } from 'nanoid';
import { api } from '@/lib/client/api';
import type { AccessEffect, AccessRule } from '@/lib/shared/agent-access';
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

interface Decision {
  tool: string;
  label: string;
  effect: AccessEffect;
  reason?: string;
}

const EFFECT_TEXT: Record<AccessEffect, string> = { allow: 'may use it', ask: 'needs approval', deny: 'may not use it' };

/** "What could this caller do?": runs the tools through the policy a run uses, with the rules on screen, and calls nothing. */
function TestPanel({ agentId, rules }: { agentId: string; rules: AccessRule[] }) {
  const [id, setId] = useState('');
  const [role, setRole] = useState('');
  const [source, setSource] = useState<SessionSource>('api');
  const [decisions, setDecisions] = useState<Decision[]>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  const check = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await api<{ decisions: Decision[] }>(`/api/agents/${agentId}/access/test`, {
        method: 'POST',
        json: { caller: { id: id.trim() || 'someone', ...(role && { role }), source }, rules },
      });
      setDecisions(result.decisions);
    } catch (e) {
      setDecisions(undefined);
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-[10px] border border-hair bg-wl p-3">
      <span className="text-[12px] font-medium text-t3">Try a caller</span>
      <div className="grid gap-2 sm:grid-cols-3">
        <Input aria-label="Caller's user id" placeholder="User id (optional)" value={id} onChange={(e) => setId(e.target.value)} />
        <Select aria-label="Caller's role" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">No role</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
        <Select aria-label="Caller comes from" value={source} onChange={(e) => setSource(e.target.value as SessionSource)}>
          {SOURCES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </div>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void check()}>
        {busy ? 'Checking…' : 'What can they do?'}
      </Button>
      {problem && <p className="text-[12px] text-red-400">{problem}</p>}
      {decisions && !decisions.length && <p className="text-[12px] text-t3">The agent has no tools.</p>}
      {decisions && decisions.length > 0 && (
        <ul className="space-y-1 text-[12px]">
          {decisions.map((d) => (
            <li key={d.tool} className="flex items-center justify-between gap-2">
              <span className="truncate">{d.label}</span>
              <span className={d.effect === 'deny' ? 'text-red-400' : d.effect === 'ask' ? 'text-amber-400' : 'text-t3'}>
                {EFFECT_TEXT[d.effect]}
                {d.reason ? ` (${d.reason})` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AccessCard({ agentId, config, update }: { agentId: string; config: AgentConfig; update: UpdateConfig }) {
  const rules = config.access?.rules ?? [];
  // The rules stay as typed (even a blank tool name while it is being edited) and an empty list is sent as an empty list: the server
  // cleans them (cleanAccess) and a missing key would not clear the saved rules.
  const setRules = (next: AccessRule[]) => update((c) => ({ ...c, access: { rules: next } }));
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
        <TestPanel agentId={agentId} rules={rules} />
      </div>
    </Section>
  );
}
