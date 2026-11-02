'use client';
/**
 * Renders a node's parameters from its PropertyDescriptor list. This is how a
 * plugin written in any language gets a UI with zero frontend code.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Braces, CornerDownRight, Info, List, Loader2, Plus, RefreshCw, Sparkles, Trash2, X } from 'lucide-react';
import { changeParameter, isPropertyVisible, withPropertyDefaults } from '@landflow/protocol';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import type { NodeItem, PropertyDescriptor } from '@/lib/shared/types';
import { FIELD_DRAG_TYPE } from '../run/data-view';
import { Input, Select, Switch } from '../ui/inputs';
import { sampleOf, type CompletionData } from './expression-completions';
import { ExpressionDataContext, ExpressionInput, loadSecretNames, ParamScopeContext as ScopeContext, type ParamScope } from './expression-input';
import { CodeEditor } from './code-editor';
import { languageOf } from './code-highlight';

type Values = Record<string, unknown>;

const isExpression = (value: unknown) => typeof value === 'string' && value.includes('{{');

/** What expressions resolve against while editing: the node's input and upstream outputs by node name. */
export interface PreviewData {
  items?: NodeItem[];
  nodeOutputs: Record<string, NodeItem[]>;
  /** Nodes `$('Name')` can refer to, upstream first (for expression suggestions). */
  nodeNames?: string[];
}

const PreviewContext = createContext<PreviewData | undefined>(undefined);

/** The node's saved-credential references, sent with live option requests. */
export type CredentialRefs = Record<string, { id: string; name: string }>;
const CredentialsContext = createContext<CredentialRefs | undefined>(undefined);

/** The node's top-level parameters, for displayOptions inside collections. */
const RootValuesContext = createContext<Values>({});

/**
 * displayOptions of a property nested in a collection, scoped as in n8n: `/name` is a top-level parameter and a plain
 * name is a sibling. A plain name that no sibling has falls back to the top-level parameter.
 */
function isNestedVisible(property: PropertyDescriptor, siblings: Values, root: Values): boolean {
  if (!property.displayOptions) return true;
  const scope: Values = { ...root, ...siblings };
  for (const [key, value] of Object.entries(root)) scope[`/${key}`] = value;
  return isPropertyVisible(property, scope);
}

/** n8n's "Result" line under an expression: the value for the first input item, or why it fails. */
function ExpressionPreview({ value }: { value: string }) {
  const data = useContext(PreviewContext);
  const workflowId = useContext(ScopeContext)?.workflowId;
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  useEffect(() => {
    if (!data) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api<{ ok: boolean; value?: unknown; error?: string }>('/api/expressions/preview', {
        method: 'POST',
        json: { value, items: (data.items ?? []).slice(0, 1), nodeOutputs: data.nodeOutputs, ...(workflowId && { workflowId }) },
        signal: controller.signal,
      })
        .then((r) => setResult(r.ok ? { ok: true, text: typeof r.value === 'string' ? r.value : JSON.stringify(r.value) } : { ok: false, text: r.error ?? 'error' }))
        .catch(() => {});
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value, data, workflowId]);
  if (!data || !result) return null;
  return (
    <div className={cn('mt-1 flex min-w-0 items-start gap-1.5 rounded-lg px-2 py-1 font-mono text-[11px] animate-fade-up', result.ok ? 'bg-gndim text-gn' : 'bg-rddim text-rd')}>
      <CornerDownRight className="mt-px size-3 shrink-0" />
      <span className="min-w-0 break-all">{result.ok ? (result.text === '' ? '(empty)' : result.text.slice(0, 300)) : result.text}</span>
      {result.ok && !data.items?.length && <span className="ml-auto shrink-0 text-t3">no input yet</span>}
    </div>
  );
}

/** Highlights a field while an input field is dragged over it; the drop inserts `{{ $json.path }}` (an empty value is replaced). */
function DropTarget({ value, onChange, children }: { value: unknown; onChange: (v: unknown) => void; children: ReactNode }) {
  const [over, setOver] = useState(false);
  const accepts = (e: DragEvent) => e.dataTransfer.types.includes(FIELD_DRAG_TYPE);
  return (
    <div
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!accepts(e)) return;
        e.preventDefault();
        const expression = e.dataTransfer.getData('text/plain');
        const current = value === undefined || value === null ? '' : String(value);
        onChange(current.trim() === '' ? expression : `${current} ${expression}`);
      }}
      className={cn('rounded-[10px] transition-shadow duration-150', over && 'shadow-[0_0_0_2px_var(--ac)] animate-pulse')}
    >
      {children}
    </div>
  );
}

function Label({ property, expression }: { property: PropertyDescriptor; expression?: boolean }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5">
      <label className="text-[12px] font-semibold text-t2">
        {property.displayName}
        {property.required && <span className="text-rd"> *</span>}
      </label>
      {expression && <span className="rounded border border-acbd bg-acdim px-1 font-mono text-[10px] font-semibold text-ac">fx</span>}
      {property.description && (
        <span className="group relative">
          <Info className="size-3 text-t3" />
          <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 w-56 -translate-x-1/2 rounded-lg border border-hair bg-sf px-2 py-1.5 text-[12px] text-t2 opacity-0 shadow-pop transition group-hover:opacity-100">
            {property.description}
          </span>
        </span>
      )}
    </div>
  );
}

type LiveOption = { name: string; value: string | number | boolean; description?: string };

/** A property's options: the static list, or loaded from the plugin with the node's parameters and credentials. */
function useLiveOptions(nodeType: string, property: PropertyDescriptor, parameters: Values) {
  const method = property.typeOptions?.loadOptionsMethod;
  // Inside a collection `parameters` holds the siblings; the plugin also needs the node's top-level values.
  const root = useContext(RootValuesContext);
  const scope = parameters === root ? root : { ...root, ...parameters };
  const deps = (property.typeOptions?.loadOptionsDependsOn ?? []).map((d) => JSON.stringify(scope[d])).join('|');
  const [options, setOptions] = useState<LiveOption[]>((property.options ?? []) as LiveOption[]);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState<string>();
  const credentials = useContext(CredentialsContext);
  const credentialKey = JSON.stringify(credentials ?? {});
  const paramScope = useContext(ScopeContext);
  // Only the latest request may set state: the one sent before a credential was auto-selected can answer last.
  const pending = useRef<AbortController>(undefined);

  const load = () => {
    if (!method) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setState('loading');
    api<{ options: LiveOption[]; error?: string }>('/api/node-types/load-options', {
      method: 'POST',
      json: { type: nodeType, method, parameters: scope, ...(credentials && { credentials }), ...paramScope },
      signal: controller.signal,
    })
      .then((r) => {
        if (controller.signal.aborted) return;
        if (r.error) throw new Error(r.error);
        if (r.options.length) setOptions(r.options);
        setState('idle');
      })
      .catch((e: Error) => {
        if (controller.signal.aborted) return;
        setError(e.message);
        setState('error');
      });
  };
  useEffect(() => {
    load();
    return () => pending.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, deps, nodeType, credentialKey, paramScope?.workflowId, paramScope?.projectId, paramScope?.agentId]);
  return { method, options, state, error, load };
}

function ReloadOptions({ state, onClick }: { state: 'idle' | 'loading' | 'error'; onClick: () => void }) {
  return (
    <button title="Reload options from the plugin" onClick={onClick} className="grid size-9 shrink-0 place-items-center rounded-[10px] border border-hair bg-wl text-t3 hover:border-ac hover:text-ac">
      {state === 'loading' ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
    </button>
  );
}

/** What an options field with nothing chosen says: its placeholder, else "Choose a team…", "Choose an operation…". */
export function choosePrompt(property: Pick<PropertyDescriptor, 'displayName' | 'placeholder'>): string {
  if (property.placeholder) return property.placeholder;
  const name = property.displayName.toLowerCase();
  return `Choose ${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}…`;
}

function LoadedOptions({ nodeType, property, value, onChange, parameters }: { nodeType: string; property: PropertyDescriptor; value: unknown; onChange: (v: unknown) => void; parameters: Values }) {
  const { method, options, state, error, load } = useLiveOptions(nodeType, property, parameters);
  // n8n's Fixed / Expression switch: type an id the list doesn't have, or an expression.
  const [typed, setTyped] = useState(() => isExpression(value));

  const current = options.find((o) => String(o.value) === String(value));
  // Nothing chosen yet: say so. Without this the browser draws the first option, which looks chosen but is not saved
  // (a new Run a Team node showed a team and ran with none), and picking that option then changes nothing.
  const unset = !current && (value === undefined || value === null || value === '');
  return (
    <div>
      <div className="flex gap-1.5">
        <div className="flex-1">
          {typed ? (
            <DropTarget value={value} onChange={onChange}>
              <ExpressionInput value={String(value ?? '')} placeholder="A value, an id or {{ $json.field }}" onChange={onChange} aria-label={property.displayName} />
            </DropTarget>
          ) : (
            <Select value={String(value ?? '')} onChange={(e) => onChange(options.find((o) => String(o.value) === e.target.value)?.value ?? e.target.value)}>
              {unset && <option value="" disabled>{choosePrompt(property)}</option>}
              {!current && !unset && <option value={String(value)}>{String(value)}</option>}
              {options.map((option) => (
                <option key={String(option.value)} value={String(option.value)}>
                  {option.name}
                </option>
              ))}
            </Select>
          )}
        </div>
        {!property.noDataExpression && (method || typed) && (
          <button
            title={typed ? 'Pick from the list' : 'Type a value or an expression'}
            onClick={() => setTyped(!typed)}
            className={cn('grid size-9 place-items-center rounded-[10px] border bg-wl hover:border-ac hover:text-ac', typed ? 'border-acbd text-ac' : 'border-hair text-t3')}
          >
            {typed ? <List className="size-3.5" /> : <Braces className="size-3.5" />}
          </button>
        )}
        {method && !typed && <ReloadOptions state={state} onClick={load} />}
      </div>
      {typed && isExpression(value) && <ExpressionPreview value={String(value)} />}
      {!typed && current?.description && <div className="mt-1 text-[12px] text-t3">{current.description}</div>}
      {!typed && state === 'error' && <div className="mt-1 text-[12px] text-warn">Live options unavailable: {error}</div>}
      {!typed && method && state !== 'error' && <div className="mt-1 text-[11px] text-t3">options loaded live via {method}()</div>}
    </div>
  );
}

function MultiOptions({ nodeType, property, value, onChange, parameters }: { nodeType: string; property: PropertyDescriptor; value: unknown; onChange: (v: unknown) => void; parameters: Values }) {
  const { method, options, state, error, load } = useLiveOptions(nodeType, property, parameters);
  const chosen = Array.isArray(value) ? value : [];
  const selected = new Set(chosen.map(String));
  // Values saved earlier that the list no longer (or not yet) has stay visible and removable.
  const known = new Set(options.map((o) => String(o.value)));
  const all: LiveOption[] = [...options, ...chosen.filter((v) => !known.has(String(v))).map((v) => ({ name: String(v), value: v as string }))];
  const toggle = (option: LiveOption) =>
    onChange(selected.has(String(option.value)) ? chosen.filter((v) => String(v) !== String(option.value)) : [...chosen, option.value]);
  return (
    <div>
      <div className="flex items-start gap-1.5">
        <div className="flex flex-1 flex-wrap gap-1.5">
          {all.map((option) => {
            const on = selected.has(String(option.value));
            return (
              <button
                key={String(option.value)}
                title={option.description}
                onClick={() => toggle(option)}
                className={cn('rounded-full border px-2.5 py-0.5 text-[12px] transition-colors', on ? 'border-ac2 bg-ac2 text-on-ac' : 'border-bd text-t2 hover:border-ac hover:text-ac')}
              >
                {option.name}
              </button>
            );
          })}
          {!all.length && <span className="py-0.5 text-[12px] text-t3">{state === 'loading' ? 'Loading…' : 'No options'}</span>}
        </div>
        {method && <ReloadOptions state={state} onClick={load} />}
      </div>
      {state === 'error' && <div className="mt-1 text-[12px] text-warn">Live options unavailable: {error}</div>}
      {method && state !== 'error' && <div className="mt-1 text-[11px] text-t3">options loaded live via {method}()</div>}
    </div>
  );
}

/** Credential fields: start a `{{ $secrets.… }}` reference (only when an external secrets provider is set up). */
function UseSecret({ onPick }: { onPick: (value: string) => void }) {
  const [providers, setProviders] = useState<string[]>([]);
  useEffect(() => {
    void loadSecretNames().then((names) => setProviders(Object.keys(names)));
  }, []);
  if (!providers.length) return null;
  return (
    <button type="button" className="mt-1 text-[11px] text-t3 hover:text-ac" onClick={() => onPick(`{{ $secrets.${providers.length === 1 ? `${providers[0]}.` : ''} }}`)}>
      Use an external secret
    </button>
  );
}

function Field({ nodeType, property, value, onChange, parameters }: { nodeType: string; property: PropertyDescriptor; value: unknown; onChange: (v: unknown) => void; parameters: Values }) {
  const expression = isExpression(value);
  const credentialField = useContext(ExpressionDataContext)?.scope === 'credential';
  const exprClass = expression ? 'border-acbd bg-acdim font-mono' : '';

  switch (property.type) {
    case 'notice':
      return (
        <div className="flex gap-2 rounded-[10px] border border-warnbd bg-warndim px-3 py-2.5 text-[12px] leading-relaxed text-warn">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          {property.displayName}
        </div>
      );
    case 'hidden':
      return null;
    case 'boolean':
      return (
        <div className="flex items-center justify-between gap-3 rounded-[10px] border border-hair bg-wl px-3 py-2">
          <div>
            <div className="text-[12px] font-semibold text-t2">{property.displayName}</div>
            {property.description && <div className="text-[12px] text-t3">{property.description}</div>}
          </div>
          <Switch checked={value === true || value === 'true'} onChange={onChange} />
        </div>
      );
    case 'options':
      return (
        <div>
          <Label property={property} />
          <LoadedOptions nodeType={nodeType} property={property} value={value ?? property.default} onChange={onChange} parameters={parameters} />
        </div>
      );
    case 'multiOptions':
      return (
        <div>
          <Label property={property} />
          <MultiOptions nodeType={nodeType} property={property} value={value} onChange={onChange} parameters={parameters} />
        </div>
      );
    case 'number':
      return (
        <div>
          <Label property={property} expression={expression} />
          <DropTarget value={value} onChange={onChange}>
            <ExpressionInput
              value={value === undefined || value === null ? '' : String(value)}
              placeholder={property.placeholder}
              plain={property.noDataExpression}
              aria-label={property.displayName}
              onChange={(raw) => onChange(raw === '' ? '' : isExpression(raw) || Number.isNaN(Number(raw)) ? raw : Number(raw))}
            />
          </DropTarget>
          {expression && <ExpressionPreview value={String(value)} />}
        </div>
      );
    case 'json':
    case 'code':
      return (
        <div>
          <Label property={property} />
          <CodeEditor
            language={languageOf(property.typeOptions?.language, property.type)}
            rows={property.typeOptions?.rows ?? 8}
            aria-label={property.displayName}
            value={typeof value === 'string' ? value : JSON.stringify(value ?? property.default ?? '', null, 2)}
            onChange={onChange}
          />
        </div>
      );
    case 'color':
      return (
        <div>
          <Label property={property} />
          <div className="flex items-center gap-2">
            <input type="color" value={String(value ?? '#141414')} onChange={(e) => onChange(e.target.value)} className="h-9 w-12 cursor-pointer rounded-[10px] border border-hair bg-transparent" />
            <Input value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
          </div>
        </div>
      );
    case 'dateTime':
      return (
        <div>
          <Label property={property} expression={expression} />
          {expression ? (
            <ExpressionInput value={String(value ?? '')} onChange={onChange} aria-label={property.displayName} />
          ) : (
            <Input type="datetime-local" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
          )}
          {expression && <ExpressionPreview value={String(value)} />}
        </div>
      );
    case 'collection':
      return <CollectionField nodeType={nodeType} property={property} value={(value as Values) ?? {}} onChange={onChange} />;
    case 'fixedCollection':
      return <FixedCollectionField nodeType={nodeType} property={property} value={(value as Record<string, Values[] | Values>) ?? {}} onChange={onChange} />;
    default: {
      const rows = property.typeOptions?.rows;
      const text = value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
      const placeholder = property.placeholder ?? (property.noDataExpression ? '' : 'Text or {{ $json.field }}');
      return (
        <div>
          <Label property={property} expression={expression} />
          <DropTarget value={value} onChange={onChange}>
            {property.typeOptions?.password && !(credentialField && /\{\{[^}]*\$secrets/.test(text)) ? (
              <Input value={text} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} type="password" className={exprClass} />
            ) : (
              <ExpressionInput value={text} placeholder={placeholder} rows={rows} plain={property.noDataExpression && !credentialField} onChange={onChange} aria-label={property.displayName} />
            )}
          </DropTarget>
          {credentialField && !expression && <UseSecret onPick={onChange} />}
          {expression && <ExpressionPreview value={String(value)} />}
          {property.hint && <div className="mt-1 text-[12px] text-t3">{property.hint}</div>}
        </div>
      );
    }
  }
}

function CollectionField({ nodeType, property, value, onChange }: { nodeType: string; property: PropertyDescriptor; value: Values; onChange: (v: unknown) => void }) {
  const root = useContext(RootValuesContext);
  const children = (property.values ?? []).filter((c) => isNestedVisible(c, value, root));
  const present = children.filter((c) => c.name in value);
  const missing = children.filter((c) => !(c.name in value));
  return (
    <div>
      <Label property={property} />
      <div className="space-y-2 rounded-[10px] border border-hair p-2.5">
        {present.map((child) => (
            <div key={child.name} className="flex items-end gap-2">
              <div className="flex-1">
                <Field nodeType={nodeType} property={child} value={value[child.name]} parameters={value} onChange={(v) => onChange({ ...value, [child.name]: v })} />
              </div>
              <button
                onClick={() => {
                  const next = { ...value };
                  delete next[child.name];
                  onChange(next);
                }}
                className="mb-1.5 grid size-7 place-items-center rounded-full text-t3 hover:bg-rddim hover:text-rd"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        {missing.length > 0 && (
          <Select value="" onChange={(e) => {
            const child = children.find((c) => c.name === e.target.value);
            if (child) onChange({ ...value, [child.name]: structuredClone(child.default ?? '') });
          }}>
            <option value="">{property.placeholder ?? 'Add option'}…</option>
            {missing.map((child) => (
              <option key={child.name} value={child.name}>
                {child.displayName}
              </option>
            ))}
          </Select>
        )}
        {!present.length && !missing.length && <div className="text-[12px] text-t3">No options</div>}
      </div>
    </div>
  );
}

function FixedCollectionField({ nodeType, property, value, onChange }: { nodeType: string; property: PropertyDescriptor; value: Record<string, Values[] | Values>; onChange: (v: unknown) => void }) {
  const root = useContext(RootValuesContext);
  const multiple = Boolean(property.typeOptions?.multipleValues);
  const groups = property.groups ?? [];
  return (
    <div>
      <Label property={property} />
      <div className="space-y-2">
        {groups.map((group) => {
          const entries: Values[] = multiple ? ((value[group.name] as Values[]) ?? []) : value[group.name] ? [value[group.name] as Values] : [];
          const write = (next: Values[]) => onChange({ ...value, [group.name]: multiple ? next : next[0] });
          const blank = () => Object.fromEntries(group.values.map((v) => [v.name, structuredClone(v.default ?? '')]));
          return (
            <div key={group.name} className="space-y-2">
                {entries.map((entry, index) => (
                  <div key={index} className="group/entry relative rounded-[10px] border border-hair bg-wl p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
                        {group.displayName} {multiple && index + 1}
                      </span>
                      <button onClick={() => write(entries.filter((_, i) => i !== index))} className="grid size-6 place-items-center rounded-full text-t3 opacity-0 transition hover:bg-rddim hover:text-rd group-hover/entry:opacity-100">
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                    <div className={cn('grid gap-2', group.values.length === 3 ? 'grid-cols-[1fr_auto_1fr] items-end' : 'grid-cols-1')}>
                      {group.values.map((child) =>
                        isNestedVisible(child, entry, root) ? (
                          <Field key={child.name} nodeType={nodeType} property={child} value={entry[child.name]} parameters={entry} onChange={(v) => write(entries.map((e, i) => (i === index ? { ...e, [child.name]: v } : e)))} />
                        ) : null,
                      )}
                    </div>
                  </div>
                ))}
              {(multiple || entries.length === 0) && (
                <button onClick={() => write([...entries, blank()])} className="flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-bd py-2 text-[12px] text-t2 transition-colors hover:border-ac hover:text-ac">
                  <Plus className="size-3.5" /> Add {group.displayName.toLowerCase()}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** `$fromAI` value types, by property type (see packages/engine/src/tool-schema.ts). */
function fromAIType(property: PropertyDescriptor): 'string' | 'number' | 'boolean' | 'json' | undefined {
  switch (property.type) {
    case 'notice':
    case 'hidden':
    case 'color':
    case 'collection':
    case 'fixedCollection':
      return undefined;
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'json':
    case 'multiOptions':
      return 'json';
    default:
      return 'string';
  }
}

const isFromAI = (value: unknown) => typeof value === 'string' && /^\{\{\s*\$fromAI\(/.test(value.trim());

/** n8n's "Let the model decide": a sparkle per field that hands the value to the agent as a `$fromAI()` argument. */
function FromAIField({ property, value, onChange, children }: { property: PropertyDescriptor; value: unknown; onChange: (v: unknown) => void; children: ReactNode }) {
  const type = fromAIType(property);
  if (!type) return <>{children}</>;
  const label = property.displayName.replace(/['"`]/g, '’');
  const toggle = (
    <button
      type="button"
      title={isFromAI(value) ? 'Set the value yourself' : 'Let the model decide'}
      aria-label={isFromAI(value) ? `Set ${property.displayName} yourself` : `Let the model decide ${property.displayName}`}
      aria-pressed={isFromAI(value)}
      onClick={() => onChange(isFromAI(value) ? structuredClone(property.default ?? '') : `{{ $fromAI('${property.name}', '${label}', '${type}') }}`)}
      className={cn('grid size-5 place-items-center rounded-md transition-colors', isFromAI(value) ? 'bg-acdim text-ac' : 'text-t3 hover:bg-acdim hover:text-ac')}
    >
      <Sparkles className="size-3" />
    </button>
  );
  if (isFromAI(value)) {
    return (
      <div className="relative">
        <Label property={property} />
        <span className="absolute right-0 top-0">{toggle}</span>
        <div className="flex h-9 items-center gap-2 rounded-[10px] border border-acbd bg-acdim px-3 text-[12px] font-semibold text-ac animate-in">
          <Sparkles className="size-3.5 shrink-0" />
          Defined by the model
          <button type="button" onClick={() => onChange(structuredClone(property.default ?? ''))} aria-label="Set the value yourself" title="Set the value yourself" className="ml-auto grid size-5 place-items-center rounded-full text-ac hover:bg-sf">
            <X className="size-3" />
          </button>
        </div>
      </div>
    );
  }
  if (property.type === 'boolean') {
    return (
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">{children}</div>
        {toggle}
      </div>
    );
  }
  return (
    <div className="relative">
      <span className="absolute right-0 top-0 z-10">{toggle}</span>
      {children}
    </div>
  );
}

export function ParamForm({
  nodeType,
  properties,
  values,
  onChange,
  preview,
  credentials,
  fromAI,
  expressionScope,
  scope,
}: {
  nodeType: string;
  properties: PropertyDescriptor[];
  values: Values;
  onChange: (values: Values) => void;
  /** Enables live expression results. */
  preview?: PreviewData;
  credentials?: CredentialRefs;
  /** Offer "Let the model decide" per field (an agent's node tools). */
  fromAI?: boolean;
  /** `credential`: a credential's form, where text fields take `{{ $secrets.<provider>.<name> }}` (and nothing else). */
  expressionScope?: 'credential';
  /** The workflow being edited: its project's data tables in pickers, its $vars in previews. */
  scope?: ParamScope;
}) {
  // Display rules see unset parameters at their defaults, as the fields show them (and as the server reads them).
  const effective = useMemo(() => withPropertyDefaults(properties, values), [properties, values]);
  const visible = properties.filter((p) => isPropertyVisible(p, effective));
  // Suggestions for expressions: the input's fields, and nodes that ran upstream with a sample of their output.
  const completionData = useMemo<CompletionData>(() => {
    const names = [...new Set([...(preview?.nodeNames ?? []), ...Object.keys(preview?.nodeOutputs ?? {})])];
    return { json: sampleOf(preview?.items), nodes: names.map((name) => ({ name, json: sampleOf(preview?.nodeOutputs[name]) })), vars: [], ...(expressionScope && { scope: expressionScope }) };
  }, [preview, expressionScope]);
  if (!visible.length) return <div className="rounded-[10px] border border-hair bg-wl p-4 text-center text-[13px] text-t3">This node has no parameters.</div>;
  return (
    <ExpressionDataContext.Provider value={completionData}>
    <ScopeContext.Provider value={scope}>
    <PreviewContext.Provider value={preview}>
      <CredentialsContext.Provider value={credentials}>
        <RootValuesContext.Provider value={effective}>
          <div className="space-y-4">
            {visible.map((property) => {
              const change = (v: unknown) => onChange(changeParameter(properties, values, property.name, v));
              const field = <Field nodeType={nodeType} property={property} value={values[property.name]} parameters={values} onChange={change} />;
              return (
                <div key={property.name}>
                  {fromAI ? (
                    <FromAIField property={property} value={values[property.name]} onChange={change}>
                      {field}
                    </FromAIField>
                  ) : (
                    field
                  )}
                </div>
              );
            })}
          </div>
        </RootValuesContext.Provider>
      </CredentialsContext.Provider>
    </PreviewContext.Provider>
    </ScopeContext.Provider>
    </ExpressionDataContext.Provider>
  );
}
