'use client';
/**
 * Build tab → Guardrails: checks on what goes into the agent (each user message) and what comes out (the final
 * answer), with the Guardrails node's checks. A rule blocks (the person gets the reply written here) or sanitizes
 * (PII, secrets, keywords and URLs are replaced and the run goes on). What a rule did shows in the session view.
 */
import { useEffect, useState } from 'react';
import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { JUDGE_PROVIDERS, type AgentConfig, type AgentGuardrail, type AgentGuardrails } from '@/lib/shared/agents';
import { Button } from '../ui/button';
import { useCredentials } from '../credentials/use-credentials';
import { Input, Select, Textarea } from '../ui/inputs';
import { Field, Section, ToggleRow } from './dialog';
import type { UpdateConfig } from './util';

/** The Guardrails node's PII entities (server/guardrails.ts). */
const PII_ENTITIES = ['EMAIL_ADDRESS', 'PHONE_NUMBER', 'CREDIT_CARD', 'IBAN_CODE', 'IP_ADDRESS', 'US_SSN', 'CRYPTO'] as const;
const DEFAULT_REPLY = 'Sorry, I can’t help with that request.';
type Stage = 'input' | 'output' | 'tool';
/** The rule of each stage lives under this key of the agent's guardrails. */
const KEY = { input: 'input', output: 'output', tool: 'toolResult' } as const;
/** An empty reply on the tool-result stage means the server's own wording (what the model reads in place of the result). */
const emptyRule = (stage: Stage): AgentGuardrail => ({
  enabled: true,
  action: 'block',
  reply: stage === 'input' ? DEFAULT_REPLY : stage === 'tool' ? '' : 'Sorry, I can’t share that answer.',
  checks: {},
});

/** A list edited as lines (or commas); committed when the field loses focus. */
function ListField({ id, value, placeholder, onChange }: { id: string; value: string[]; placeholder?: string; onChange: (list: string[]) => void }) {
  const [text, setText] = useState(value.join('\n'));
  useEffect(() => setText(value.join('\n')), [value]);
  return (
    <Textarea
      id={id}
      rows={2}
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() =>
        onChange(
          text
            .split(/[\n,]/)
            .map((entry) => entry.trim())
            .filter(Boolean),
        )
      }
    />
  );
}

function RuleEditor({ stage, rule, onChange }: { stage: Stage; rule: AgentGuardrail; onChange: (rule: AgentGuardrail) => void }) {
  const { checks } = rule;
  const setChecks = (patch: Partial<AgentGuardrail['checks']>) => {
    const next = { ...checks, ...patch };
    for (const key of Object.keys(next) as Array<keyof typeof next>) if (next[key] === undefined) delete next[key];
    onChange({ ...rule, checks: next });
  };
  const sanitize = rule.action === 'sanitize';
  const id = (name: string) => `gr-${stage}-${name}`;
  const { credentials } = useCredentials();
  const judgeProvider = JUDGE_PROVIDERS.find((p) => p.value === rule.judge?.provider);
  const judgeOptions = (credentials ?? []).filter((c) => c.type === judgeProvider?.credentialType);
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={id('action')} label="When a check finds something" hint={sanitize ? 'Replace what was found and carry on. Checks that need a model do not run.' : 'Stop here and answer with the reply below.'}>
          <Select id={id('action')} value={rule.action} onChange={(e) => onChange({ ...rule, action: e.target.value as AgentGuardrail['action'] })}>
            <option value="block">Block</option>
            <option value="sanitize">Sanitize</option>
          </Select>
        </Field>
        {sanitize ? (
          <Field id={id('replacement')} label="Replace with" hint="A placeholder such as <EMAIL_ADDRESS>, or the value partly hidden">
            <Select id={id('replacement')} value={rule.replacement ?? 'redact'} onChange={(e) => onChange({ ...rule, replacement: e.target.value as 'redact' | 'mask' })}>
              <option value="redact">Placeholder</option>
              <option value="mask">Masked value</option>
            </Select>
          </Field>
        ) : (
          <Field id={id('reply')} label="Reply when blocked" hint={stage === 'input' ? 'Sent instead of running the agent' : stage === 'tool' ? 'What the model reads instead of the result; leave empty for the standard notice' : 'Sent instead of the agent’s answer'}>
            <Textarea id={id('reply')} rows={2} value={rule.reply} onChange={(e) => onChange({ ...rule, reply: e.target.value })} />
          </Field>
        )}
      </div>
      {!sanitize && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={id('judge')} label="Judge the model checks with" hint={judgeProvider?.description ?? 'The agent’s own model answers each model check'}>
            <Select
              id={id('judge')}
              value={rule.judge?.provider ?? ''}
              onChange={(e) => {
                const { judge: _old, ...rest } = rule;
                // The credential belongs to the provider, so the choice starts over; when only one exists, take it.
                const options = (credentials ?? []).filter((c) => c.type === JUDGE_PROVIDERS.find((p) => p.value === e.target.value)?.credentialType);
                onChange(e.target.value ? { ...rest, judge: { provider: e.target.value, ...(options.length === 1 && { credential: { id: options[0].id, name: options[0].name } }) } } : rest);
              }}
            >
              <option value="">The agent’s model</option>
              {JUDGE_PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
              {rule.judge && !judgeProvider && <option value={rule.judge.provider}>{rule.judge.provider} (unknown)</option>}
            </Select>
          </Field>
          {judgeProvider && (
            <Field id={id('judge-credential')} label="Credential" hint={judgeOptions.length || !credentials ? undefined : `Add a credential of this type under Credentials`}>
              <Select
                id={id('judge-credential')}
                value={rule.judge?.credential?.id ?? ''}
                onChange={(e) => {
                  const picked = judgeOptions.find((c) => c.id === e.target.value);
                  onChange({ ...rule, judge: { ...rule.judge!, ...(picked ? { credential: { id: picked.id, name: picked.name } } : { credential: undefined }) } });
                }}
              >
                <option value="">Choose…</option>
                {rule.judge?.credential && !judgeOptions.some((c) => c.id === rule.judge?.credential?.id) && <option value={rule.judge.credential.id}>{rule.judge.credential.name} (missing)</option>}
                {judgeOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
      )}
      <div className="space-y-2">
        <ToggleRow title="Personal data (PII)" description="Emails, phone numbers, card numbers, IBANs, IP addresses, SSNs, crypto wallets" checked={Boolean(checks.pii)} onChange={(on) => setChecks({ pii: on ? { entities: [...PII_ENTITIES] } : undefined })} />
        <ToggleRow title="Secret keys" description="API keys, tokens and private keys" checked={Boolean(checks.secrets)} onChange={(on) => setChecks({ secrets: on ? { permissiveness: 'balanced' } : undefined })} />
        <ToggleRow title="Keywords" description="Words and phrases that must not appear" checked={Boolean(checks.keywords)} onChange={(on) => setChecks({ keywords: on ? { list: [] } : undefined })} />
        {checks.keywords && (
          <Field id={id('keywords')} label="Keywords" hint="One per line or comma-separated; case-insensitive">
            <ListField id={id('keywords')} value={checks.keywords.list} onChange={(list) => setChecks({ keywords: { list } })} />
          </Field>
        )}
        <ToggleRow title="URLs" description="Links outside an allow-list (an empty list blocks every link)" checked={Boolean(checks.urls)} onChange={(on) => setChecks({ urls: on ? { allowed: [], schemes: ['https'], blockUserinfo: true, allowSubdomains: true } : undefined })} />
        {checks.urls && (
          <Field id={id('urls')} label="Allowed URLs" hint="Domains, *.domain or URL prefixes, one per line">
            <ListField id={id('urls')} value={checks.urls.allowed} placeholder="example.com" onChange={(allowed) => setChecks({ urls: { ...checks.urls!, allowed } })} />
          </Field>
        )}
        <ToggleRow title="Prompt injection" description="Jailbreak and instruction-override patterns" checked={Boolean(checks.jailbreak)} onChange={(on) => setChecks({ jailbreak: on ? { threshold: 0.7, useModel: false } : undefined })} />
        {checks.jailbreak && !sanitize && (
          <ToggleRow title="Also ask the agent’s model" description="A second opinion from the model (one more call per message)" checked={Boolean(checks.jailbreak.useModel)} onChange={(useModel) => setChecks({ jailbreak: { ...checks.jailbreak!, useModel } })} />
        )}
        {!sanitize && (
          <>
            {stage !== 'tool' && (
              <ToggleRow title="Stay on topic" description="Flag anything outside the subjects you list, judged by the agent’s model" checked={Boolean(checks.topical)} onChange={(on) => setChecks({ topical: on ? { prompt: '', threshold: 0.7 } : undefined })} />
            )}
            {stage !== 'tool' && checks.topical && (
              <Field id={id('topical')} label="What the agent may talk about" hint="Greetings and short follow-ups count as on topic">
                <Textarea id={id('topical')} rows={2} value={checks.topical.prompt} placeholder="Parcel delivery, refunds and our policies" onChange={(e) => setChecks({ topical: { ...checks.topical!, prompt: e.target.value } })} />
              </Field>
            )}
            {stage === 'output' && (
              <ToggleRow title="Grounded in the knowledge base" description="Flag an answer the passages its knowledge base returned do not support. Only runs for an agent that has a knowledge base; one more model call per answer." checked={Boolean(checks.grounded)} onChange={(on) => setChecks({ grounded: on ? { threshold: 0.7 } : undefined })} />
            )}
            <ToggleRow title="Moderation" description="Not-safe-for-work, hateful or violent content, judged by the agent’s model" checked={Boolean(checks.nsfw)} onChange={(on) => setChecks({ nsfw: on ? { threshold: 0.7 } : undefined })} />
            <div className="rounded-[10px] border border-hair bg-wl px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-[13px] font-semibold text-t1">Custom checks</div>
                  <div className="text-[12px] leading-snug text-t3">Describe what to flag; the agent’s model judges each text</div>
                </div>
                <Button variant="outline" size="sm" onClick={() => setChecks({ custom: [...(checks.custom ?? []), { name: `Check ${(checks.custom?.length ?? 0) + 1}`, prompt: '' }] })}>
                  <Plus className="size-3.5" /> Add
                </Button>
              </div>
              {checks.custom?.map((check, index) => (
                <div key={index} className="mt-2 grid grid-cols-[1fr_auto] gap-2">
                  <Input aria-label="Check name" value={check.name} onChange={(e) => setChecks({ custom: checks.custom!.map((c, i) => (i === index ? { ...c, name: e.target.value } : c)) })} />
                  <button type="button" aria-label="Remove check" className="text-t3 hover:text-red-600" onClick={() => setChecks({ custom: checks.custom!.filter((_, i) => i !== index).length ? checks.custom!.filter((_, i) => i !== index) : undefined })}>
                    <Trash2 className="size-3.5" />
                  </button>
                  <Textarea
                    className="col-span-2"
                    rows={2}
                    aria-label="What to flag"
                    value={check.prompt}
                    placeholder="Flag texts that give legal advice"
                    onChange={(e) => setChecks({ custom: checks.custom!.map((c, i) => (i === index ? { ...c, prompt: e.target.value } : c)) })}
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function GuardrailsCard({ config, update }: { config: AgentConfig; update: UpdateConfig }) {
  const set = (stage: Stage, rule: AgentGuardrail | undefined) =>
    update((c) => {
      const key = KEY[stage];
      const guardrails: AgentGuardrails = { ...c.guardrails, [key]: rule };
      if (!guardrails[key]) delete guardrails[key];
      const { guardrails: _old, ...rest } = c;
      return guardrails.input || guardrails.output || guardrails.toolResult ? { ...rest, guardrails } : rest;
    });
  return (
    <Section icon={<ShieldCheck className="size-4" />} title="Guardrails" description="Check what people send the agent, what its tools return and what it answers: block it with a reply of your own, or sanitize it. What a guardrail did shows in the session and its trace.">
      <div className="space-y-5">
        {(['input', 'tool', 'output'] as const).map((stage) => {
          const rule = config.guardrails?.[KEY[stage]];
          return (
            <div key={stage} className="space-y-3">
              <ToggleRow
                title={stage === 'input' ? 'Input guardrails' : stage === 'tool' ? 'Tool result guardrails' : 'Output guardrails'}
                description={stage === 'input' ? 'Each user message, before the model sees it' : stage === 'tool' ? 'What each tool returns, before the model reads it: an email, web page or ticket can carry planted instructions' : 'The final answer, before it is sent'}
                checked={Boolean(rule?.enabled)}
                onChange={(on) => set(stage, on ? { ...(rule ?? emptyRule(stage)), enabled: true } : rule && { ...rule, enabled: false })}
              />
              {rule?.enabled && <RuleEditor stage={stage} rule={rule} onChange={(next) => set(stage, next)} />}
            </div>
          );
        })}
      </div>
    </Section>
  );
}
