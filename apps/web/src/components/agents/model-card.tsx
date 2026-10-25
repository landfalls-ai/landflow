'use client';
/** Build tab → Model & instructions: provider, credential or server, model, temperature and the system prompt. */
import { useEffect, useLayoutEffect, useRef, useState, type TextareaHTMLAttributes } from 'react';
import { Brain, Loader2, Pencil, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import type { AgentConfig, AgentModel, ModelOption, ModelProvider } from '@/lib/shared/agents';
import { CredentialDialog } from '../credentials/credential-dialog';
import { useCredentials } from '../credentials/use-credentials';
import { Button } from '../ui/button';
import { Input, Select, Textarea } from '../ui/inputs';
import { Field, Section } from './dialog';
import { DEFAULT_OLLAMA_URL, PROVIDERS, type UpdateConfig } from './util';

const CREATE = '__create__';
const CUSTOM = '__custom__';

/** A textarea that grows with its text. */
export function AutoTextarea({ className, value, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 640)}px`;
  }, [value]);
  return <Textarea ref={ref} value={value} className={cn('resize-none overflow-y-auto', className)} {...props} />;
}

function ModelPicker({ model, onChange }: { model: AgentModel; onChange: (patch: Partial<AgentModel>) => void }) {
  const [options, setOptions] = useState<ModelOption[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState<string>();
  const [custom, setCustom] = useState(false);
  const [nonce, setNonce] = useState(0);
  const provider = PROVIDERS.find((p) => p.value === model.provider);
  const blocked = provider?.credentialRequired && !model.credential;

  useEffect(() => {
    if (blocked) {
      setOptions([]);
      setState('idle');
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        setState('loading');
        const params = new URLSearchParams({ provider: model.provider });
        if (model.credential) params.set('credentialId', model.credential.id);
        if (model.provider === 'ollama' && model.baseUrl) params.set('baseUrl', model.baseUrl);
        api<{ options: ModelOption[]; error?: string }>(`/api/agents/models?${params}`, { signal: controller.signal })
          .then((r) => {
            setOptions(r.options ?? []);
            setError(r.error);
            setState(r.error ? 'error' : 'idle');
          })
          .catch((e: Error) => {
            if (controller.signal.aborted) return;
            setOptions([]);
            setError(e.message);
            setState('error');
          });
      },
      model.provider === 'ollama' ? 400 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [model.provider, model.credential?.id, model.baseUrl, blocked, nonce]);

  const known = options.some((o) => o.model === model.model);
  const typed = custom || (!options.length && state !== 'loading');
  const current = options.find((o) => o.model === model.model);

  return (
    <Field
      id="agent-model"
      label="Model"
      required
      aside={
        options.length > 0 && (
          <button type="button" className="text-ac hover:underline" onClick={() => setCustom(!custom)}>
            {custom ? 'Pick from the list' : 'Type a model id'}
          </button>
        )
      }
      hint={
        blocked ? (
          'Choose a credential to list its models.'
        ) : state === 'error' ? (
          <span className="text-warn">Could not list models: {error}. Type a model id instead.</span>
        ) : (
          current?.description
        )
      }
    >
      <div className="flex gap-1.5">
        <div className="min-w-0 flex-1">
          {typed ? (
            <Input
              id="agent-model"
              value={model.model}
              onChange={(e) => onChange({ model: e.target.value })}
              placeholder={model.provider === 'anthropic' ? 'claude-sonnet-5-5' : model.provider === 'ollama' ? 'llama3.2' : 'gpt-4.1-mini'}
              className="font-mono"
            />
          ) : (
            <Select
              id="agent-model"
              value={model.model}
              onChange={(e) => {
                if (e.target.value === CUSTOM) setCustom(true);
                else onChange({ model: e.target.value });
              }}
            >
              <option value="">{state === 'loading' ? 'Loading models…' : 'Choose a model…'}</option>
              {!known && model.model && <option value={model.model}>{model.model}</option>}
              {options.map((o) => (
                <option key={o.model} value={o.model}>
                  {o.label}
                </option>
              ))}
              <option value={CUSTOM}>Other model id…</option>
            </Select>
          )}
        </div>
        <button
          type="button"
          title="Reload the model list"
          aria-label="Reload the model list"
          disabled={blocked}
          onClick={() => setNonce((n) => n + 1)}
          className="grid size-9 shrink-0 place-items-center rounded-[10px] border border-hair bg-wl text-t3 hover:border-ac hover:text-ac disabled:opacity-45"
        >
          {state === 'loading' ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        </button>
      </div>
    </Field>
  );
}

export function ModelCard({ config, update }: { config: AgentConfig; update: UpdateConfig }) {
  const model = config.model;
  const provider = PROVIDERS.find((p) => p.value === model?.provider);
  const { credentials } = useCredentials();
  const [dialog, setDialog] = useState<{ id?: string } | null>(null);
  const options = provider?.credentialType ? (credentials ?? []).filter((c) => c.type === provider.credentialType) : [];
  const missing = model?.credential && credentials && !options.some((c) => c.id === model.credential?.id);

  const setModel = (patch: Partial<AgentModel>) =>
    update((c) => ({
      ...c,
      model: { ...(c.model ?? { provider: 'anthropic', model: '' }), ...patch },
    }));

  // Like the node panel: an OpenAI-compatible model needs a credential, so when exactly one exists, pick it.
  useEffect(() => {
    if (!provider?.credentialRequired || model?.credential || options.length !== 1) return;
    setModel({ credential: { id: options[0].id, name: options[0].name } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider?.value, options.length, model?.credential]);

  const changeProvider = (value: ModelProvider | '') =>
    update((c) => {
      if (!value) {
        const { model: _drop, ...rest } = c;
        return rest;
      }
      return {
        ...c,
        model: {
          provider: value,
          model: '',
          ...(value === 'ollama' && { baseUrl: DEFAULT_OLLAMA_URL }),
          ...(c.model?.temperature !== undefined && {
            temperature: c.model.temperature,
          }),
        },
      };
    });

  return (
    <Section icon={<Brain className="size-4" />} title="Model & instructions" description="The model that thinks and the instructions it always follows.">
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="agent-provider" label="Provider" required>
            <Select id="agent-provider" value={model?.provider ?? ''} onChange={(e) => changeProvider(e.target.value as ModelProvider | '')}>
              <option value="">Choose a provider…</option>
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          {provider?.credentialType && model && (
            <Field
              id="agent-credential"
              label="Credential"
              required={provider.credentialRequired}
              hint={
                missing ? (
                  <span className="text-warn">“{model.credential?.name}” was deleted. Choose or create another.</span>
                ) : !provider.credentialRequired && !model.credential ? (
                  'Optional: without one the server’s ANTHROPIC_API_KEY is used.'
                ) : undefined
              }
            >
              <div className="flex gap-1.5">
                <div className="min-w-0 flex-1">
                  <Select
                    id="agent-credential"
                    value={missing ? '' : (model.credential?.id ?? '')}
                    onChange={(e) => {
                      if (e.target.value === CREATE) return setDialog({});
                      const picked = options.find((c) => c.id === e.target.value);
                      update((c) => {
                        const { credential: _drop, ...rest } = c.model!;
                        return {
                          ...c,
                          model: picked
                            ? {
                                ...rest,
                                credential: {
                                  id: picked.id,
                                  name: picked.name,
                                },
                              }
                            : rest,
                        };
                      });
                    }}
                  >
                    <option value="">{options.length ? (provider.credentialRequired ? 'Select a credential…' : 'Server default') : 'No credential yet'}</option>
                    {options.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                    <option value={CREATE}>+ Create credential</option>
                  </Select>
                </div>
                {model.credential && !missing && (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setDialog({ id: model.credential?.id })}
                    title="Edit this credential"
                    aria-label="Edit credential"
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                )}
              </div>
            </Field>
          )}
          {model?.provider === 'ollama' && (
            <Field id="agent-base-url" label="Server URL" hint="Where Ollama listens.">
              <Input
                id="agent-base-url"
                value={model.baseUrl ?? ''}
                placeholder={DEFAULT_OLLAMA_URL}
                onChange={(e) => setModel({ baseUrl: e.target.value })}
                className="font-mono"
              />
            </Field>
          )}
        </div>
        {model && (
          <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
            <ModelPicker model={model} onChange={setModel} />
            <Field id="agent-temperature" label="Temperature">
              <Input
                id="agent-temperature"
                type="number"
                min={0}
                max={2}
                step={0.1}
                placeholder="Default"
                value={model.temperature ?? ''}
                onChange={(e) =>
                  update((c) => {
                    const { temperature: _drop, ...rest } = c.model!;
                    const value = e.target.value === '' ? undefined : Number(e.target.value);
                    return {
                      ...c,
                      model:
                        value === undefined || Number.isNaN(value)
                          ? rest
                          : {
                              ...rest,
                              temperature: Math.min(2, Math.max(0, value)),
                            },
                    };
                  })
                }
              />
            </Field>
          </div>
        )}
        <Field
          id="agent-instructions"
          label="Instructions"
          required
          hint="Who the agent is, what it should do and how. Sent as the system prompt on every turn."
        >
          <AutoTextarea
            id="agent-instructions"
            rows={5}
            value={config.instructions}
            onChange={(e) => {
              const instructions = e.target.value;
              update((c) => ({ ...c, instructions }));
            }}
            placeholder="Summarize new tickets in the Customer Support Slack channel."
            className="min-h-[120px]"
          />
        </Field>
      </div>
      {dialog && provider?.credentialType && (
        <CredentialDialog
          credentialId={dialog.id}
          allowedTypes={[provider.credentialType]}
          onClose={() => setDialog(null)}
          onSaved={(credential) =>
            setModel({
              credential: { id: credential.id, name: credential.name },
            })
          }
        />
      )}
    </Section>
  );
}
