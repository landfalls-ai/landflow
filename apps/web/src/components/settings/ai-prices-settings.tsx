'use client';
/**
 * Settings → AI prices: the price table AI costs are estimated with (token & cost tracking, the caps in workflow
 * and agent settings, Insights). Built-in list prices for Anthropic and OpenAI, read-only, and the instance's
 * overrides, which win per model. USD per million tokens; a model id also prices ids that start with it.
 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, CircleDollarSign, Plus, Save, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { can } from '@/lib/shared/auth';
import { formatTokens, type ModelPrice, type PriceTable } from '@/lib/shared/ai-usage';
import type { AiLocalModel } from '@/lib/shared/ai-spend';
import { useViewer } from '@/components/auth/viewer';
import { Card } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { HelpTip } from '@/components/ui/help-tip';
import { Input, SectionLabel } from '@/components/ui/inputs';

/** An override row as typed (numbers kept as text until saved). */
interface Row {
  key: number;
  provider: string;
  model: string;
  input: string;
  output: string;
  /** Empty = the input price. */
  cacheRead: string;
  cacheWrite: string;
}

let nextKey = 1;
const toRow = (price: ModelPrice): Row => ({
  key: nextKey++,
  provider: price.provider,
  model: price.model,
  input: String(price.input),
  output: String(price.output),
  cacheRead: price.cacheRead === undefined ? '' : String(price.cacheRead),
  cacheWrite: price.cacheWrite === undefined ? '' : String(price.cacheWrite),
});
const usd = (value: number) => `$${value.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;

/** The rows as prices, or the first problem. */
function parse(rows: Row[]): { prices: ModelPrice[] } | { error: string } {
  const prices: ModelPrice[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const provider = row.provider.trim().toLowerCase();
    const model = row.model.trim();
    if (!provider && !model && !row.input.trim() && !row.output.trim() && !row.cacheRead.trim() && !row.cacheWrite.trim()) continue;
    if (!provider || !model) return { error: 'Every override needs a provider and a model' };
    const input = Number(row.input);
    const output = Number(row.output);
    if (row.input.trim() === '' || row.output.trim() === '' || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
      return { error: `${provider}/${model}: prices are USD per million tokens, 0 or more` };
    }
    const cache = (text: string) => (text.trim() === '' ? undefined : Number(text));
    const cacheRead = cache(row.cacheRead);
    const cacheWrite = cache(row.cacheWrite);
    if ([cacheRead, cacheWrite].some((value) => value !== undefined && (!Number.isFinite(value) || value < 0))) return { error: `${provider}/${model}: cache prices are USD per million tokens, 0 or more (or empty for the input price)` };
    const id = `${provider}/${model.toLowerCase()}`;
    if (seen.has(id)) return { error: `${provider}/${model} is listed twice` };
    seen.add(id);
    prices.push({ provider, model, input, output, ...(cacheRead !== undefined && { cacheRead }), ...(cacheWrite !== undefined && { cacheWrite }) });
  }
  return { prices };
}

export function AiPricesSettings() {
  const viewer = useViewer();
  const admin = can(viewer, 'settings:manage');
  const [showBuiltIn, setShowBuiltIn] = useState(false);
  const [table, setTable] = useState<PriceTable>();
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const [local, setLocal] = useState<AiLocalModel[]>();
  const loadLocal = () =>
    api<AiLocalModel[]>('/api/settings/ai-prices/local')
      .then(setLocal)
      .catch(() => setLocal([]));
  const apply = (next: PriceTable) => {
    setTable(next);
    setRows(next.overrides.map(toRow));
    loadLocal();
  };
  useEffect(() => {
    api<PriceTable>('/api/settings/ai-prices')
      .then(apply)
      .catch((e: Error) => setError(e.message));
  }, []);

  const parsed = useMemo(() => parse(rows), [rows]);
  const dirty = Boolean(table && 'prices' in parsed && JSON.stringify(parsed.prices) !== JSON.stringify(table.overrides));
  const set = (key: number, patch: Partial<Row>) => setRows((list) => list.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const add = (price?: ModelPrice) => setRows((list) => [...list, toRow(price ?? { provider: 'ollama', model: '', input: 0, output: 0 })]);
  const overridden = new Set(rows.map((row) => `${row.provider.trim().toLowerCase()}/${row.model.trim().toLowerCase()}`));
  const defaults = (table?.defaults ?? []).filter((price) => !filter.trim() || `${price.provider}/${price.model}`.toLowerCase().includes(filter.trim().toLowerCase()));

  const save = async () => {
    if (!('prices' in parsed)) return setError(parsed.error);
    setSaving(true);
    setError(undefined);
    try {
      apply(await api<PriceTable>('/api/settings/ai-prices', { method: 'PUT', json: { overrides: parsed.prices } }));
      toast.success('AI prices saved');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!table) {
    return error ? (
      <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>
    ) : (
      <div className="h-48 rounded-2xl border border-hair bg-sf animate-pulse-soft" />
    );
  }

  const cell = 'h-8 px-2 font-mono text-[12px]';
  return (
    <div className="space-y-4">
      {/* SP12: local models, priced here */}
      <LocalModels
        models={local}
        admin={admin}
        onPrice={async (model, input, output) => {
          // The saved list plus one `ollama/<model>` price: edits still unsaved in the table below are not saved with it.
          const overrides = [...table.overrides.filter((p) => !(p.provider.toLowerCase() === 'ollama' && p.model.toLowerCase() === model.toLowerCase())), { provider: 'ollama', model, input, output }];
          apply(await api<PriceTable>('/api/settings/ai-prices', { method: 'PUT', json: { overrides } }));
          toast.success(`Priced ${model}`);
        }}
      />
      <Card className="px-5 py-4">
        <div className="mb-1 flex items-center gap-2">
          <CircleDollarSign className="size-4 text-t3" strokeWidth={1.8} />
          <SectionLabel>Your prices</SectionLabel>
          {admin && (
            <Button size="sm" className="ml-auto" onClick={() => add()}>
              <Plus className="size-3.5" /> Add price
            </Button>
          )}
        </div>
        <p className="mb-3 text-[12px] leading-relaxed text-t3">
          Your prices win over the built-in ones, in USD per million tokens.
          <HelpTip label="How prices are matched" className="ml-1 align-middle">
            A model id also prices the ids that start with it (<code className="font-mono">claude-sonnet-5-5</code> prices <code className="font-mono">claude-sonnet-5-5-20261001</code>). Cache read and write prices apply to
            the cached part of the prompt; empty means the input price. Ollama and other local models cost $0 unless you price them here; a price applies from the moment you save it, and earlier calls keep the cost they had. Costs are estimates; your provider’s bill is what counts.
          </HelpTip>
          {' '}
          <a href="/settings#ai-caps" className="relative whitespace-nowrap text-t2 underline-offset-2 hover:underline">Usage caps are in AI caps ›</a>
        </p>
        {rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-[13px]">
              <thead>
                <tr className="text-left text-[12px] text-t2">
                  <th className="pb-1.5 pr-2 font-semibold">Provider</th>
                  <th className="pb-1.5 pr-2 font-semibold">Model (or prefix)</th>
                  <th className="pb-1.5 pr-2 text-right font-semibold">Input $/M</th>
                  <th className="pb-1.5 pr-2 text-right font-semibold">Output $/M</th>
                  <th className="pb-1.5 pr-2 text-right font-semibold" title="Cached input read (Anthropic cache read, OpenAI cached input)">
                    Cache read $/M
                  </th>
                  <th className="pb-1.5 pr-2 text-right font-semibold" title="Tokens written to Anthropic's cache">
                    Cache write $/M
                  </th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td className="py-1 pr-2">
                      <Input value={row.provider} onChange={(e) => set(row.key, { provider: e.target.value })} disabled={!admin} placeholder="ollama" aria-label="Provider" className={`${cell} w-32`} list="ai-price-providers" />
                    </td>
                    <td className="py-1 pr-2">
                      <Input value={row.model} onChange={(e) => set(row.key, { model: e.target.value })} disabled={!admin} placeholder="qwen3-coder" aria-label="Model" className={cell} />
                    </td>
                    <td className="py-1 pr-2">
                      <Input value={row.input} onChange={(e) => set(row.key, { input: e.target.value })} disabled={!admin} inputMode="decimal" aria-label="Input price" className={`${cell} w-24 text-right`} />
                    </td>
                    <td className="py-1 pr-2">
                      <Input value={row.output} onChange={(e) => set(row.key, { output: e.target.value })} disabled={!admin} inputMode="decimal" aria-label="Output price" className={`${cell} w-24 text-right`} />
                    </td>
                    <td className="py-1 pr-2">
                      <Input value={row.cacheRead} onChange={(e) => set(row.key, { cacheRead: e.target.value })} disabled={!admin} inputMode="decimal" placeholder="= input" aria-label="Cache read price" className={`${cell} w-24 text-right`} />
                    </td>
                    <td className="py-1 pr-2">
                      <Input value={row.cacheWrite} onChange={(e) => set(row.key, { cacheWrite: e.target.value })} disabled={!admin} inputMode="decimal" placeholder="= input" aria-label="Cache write price" className={`${cell} w-24 text-right`} />
                    </td>
                    <td className="py-1">
                      {admin && (
                        <Button size="icon-sm" variant="ghost" aria-label="Remove price" title="Remove" className="hover:bg-rddim hover:text-rd" onClick={() => setRows((list) => list.filter((r) => r.key !== row.key))}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <datalist id="ai-price-providers">
              {['anthropic', 'openai', 'ollama', 'ollama_chat'].map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </div>
        ) : (
          <p className="rounded-[10px] border border-dashed border-bd px-3 py-3 text-center text-[12px] text-t3">No overrides: the built-in prices below apply, and local models are free.</p>
        )}
        {error && <div className="mt-3 rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd animate-fade-up">{error}</div>}
        {admin && (
          <div className="mt-3 flex items-center justify-end gap-2 border-t border-hair pt-3.5">
            {'error' in parsed && <span className="mr-auto text-[12px] text-warn">{parsed.error}</span>}
            {dirty && (
              <Button variant="ghost" onClick={() => setRows(table.overrides.map(toRow))}>
                Discard
              </Button>
            )}
            <Button variant="primary" onClick={save} loading={saving} disabled={!dirty}>
              <Save className="size-3.5" /> Save
            </Button>
          </div>
        )}
        {!admin && <p className="mt-3 text-[12px] text-t3">Only owners and admins can change prices.</p>}
      </Card>

      <Card className="px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" aria-expanded={showBuiltIn} aria-controls="ai-builtin-prices" onClick={() => setShowBuiltIn((v) => !v)} className="flex min-h-8 items-center gap-1.5 text-[13px] font-semibold text-t1 max-md:min-h-11">
            {showBuiltIn ? <ChevronDown className="size-4 text-t3" /> : <ChevronRight className="size-4 text-t3" />}
            {showBuiltIn ? 'Hide built-in prices' : 'Show built-in prices'}
            <span className="font-normal text-t3">({defaults.length})</span>
          </button>
          {showBuiltIn && (
            <div className="relative ml-auto">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-t3" />
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter models" aria-label="Filter models" className="h-8 w-48 pl-8 text-[12px]" />
            </div>
          )}
        </div>
        {showBuiltIn && (
          <div id="ai-builtin-prices" className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-hair text-left text-[12px] text-t2">
                  <th className="h-8 pr-2 font-semibold">Provider</th>
                  <th className="h-8 pr-2 font-semibold">Model</th>
                  <th className="h-8 pr-2 text-right font-semibold">Input</th>
                  <th className="h-8 pr-2 text-right font-semibold">Output</th>
                  <th className="h-8 pr-2 text-right font-semibold">Cache read</th>
                  <th className="h-8 pr-2 text-right font-semibold">Cache write</th>
                  <th className="w-24" />
                </tr>
              </thead>
              <tbody>
                {defaults.map((price) => {
                  const replaced = overridden.has(`${price.provider}/${price.model.toLowerCase()}`);
                  return (
                    <tr key={`${price.provider}/${price.model}`} className="border-b border-hair last:border-b-0">
                      <td className="py-1.5 pr-2 text-t2">{price.provider}</td>
                      <td className={`py-1.5 pr-2 font-mono text-[12px] ${replaced ? 'text-t3 line-through' : 'text-t1'}`}>{price.model}</td>
                      <td className="py-1.5 pr-2 text-right font-mono text-[12px] tabular-nums text-t2">{usd(price.input)}</td>
                      <td className="py-1.5 pr-2 text-right font-mono text-[12px] tabular-nums text-t2">{usd(price.output)}</td>
                      <td className="py-1.5 pr-2 text-right font-mono text-[12px] tabular-nums text-t2">{price.cacheRead === undefined ? '—' : usd(price.cacheRead)}</td>
                      <td className="py-1.5 pr-2 text-right font-mono text-[12px] tabular-nums text-t2">{price.cacheWrite === undefined ? '—' : usd(price.cacheWrite)}</td>
                      <td className="py-1 text-right">
                        {admin && !replaced && (
                          <Button size="sm" variant="ghost" onClick={() => add(price)} title="Copy into your prices to change it">
                            Override
                          </Button>
                        )}
                        {replaced && <span className="text-[11px] text-t3">overridden</span>}
                      </td>
                    </tr>
                  );
                })}
                {!defaults.length && (
                  <tr>
                    <td colSpan={7} className="py-4 text-center text-[12px] text-t3">
                      No built-in price matches “{filter}”.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/** SP12: the models seen on your own hardware in the last 30 days, with calls and tokens, and a price for each (from now on). */
function LocalModels({ models, admin, onPrice }: { models?: AiLocalModel[]; admin: boolean; onPrice: (model: string, input: number, output: number) => Promise<void> }) {
  const [open, setOpen] = useState<string>();
  const [input, setInput] = useState('0');
  const [output, setOutput] = useState('0');
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (model: string) => {
    const i = Number(input);
    const o = Number(output);
    if (input.trim() === '' || output.trim() === '' || !Number.isFinite(i) || !Number.isFinite(o) || i < 0 || o < 0) return setProblem('Prices are USD per million tokens, 0 or more');
    setBusy(true);
    setProblem(undefined);
    try {
      await onPrice(model, i, o);
      setOpen(undefined);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="px-5 py-4">
      <div className="mb-1 flex items-center gap-2">
        <SectionLabel>Local models</SectionLabel>
        <span className="text-[12px] text-t3">last 30 days</span>
      </div>
      <p className="mb-3 text-[12px] leading-relaxed text-t3">
        Models that ran on your own hardware, called by Landflow or through the gateway. They cost $0 until you price them; a price applies from the moment you save it, and earlier calls keep the cost they had.
      </p>
      {!models ? (
        <div className="h-12 rounded-xl bg-acdim animate-pulse-soft" />
      ) : models.length === 0 ? (
        <p className="rounded-[10px] border border-dashed border-bd px-3 py-3 text-center text-[12px] text-t3">No local model was called in the last 30 days.</p>
      ) : (
        <ul className="divide-y divide-hair">
          {models.map((m) => (
            <li key={m.model} className="flex flex-col gap-2 py-2.5">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[13px]">
                <span className="font-mono text-[12px] text-t1">{m.model}</span>
                <span className="text-[12px] text-t3">{m.providers.join(', ')}</span>
                <span className="ml-auto tabular-nums text-t2">
                  {m.calls.toLocaleString('en-US')} call{m.calls === 1 ? '' : 's'} · {formatTokens(m.inputTokens + m.outputTokens)} tokens
                </span>
                {m.price ? (
                  <span className="tabular-nums text-t1">
                    {usd(m.price.input)} in · {usd(m.price.output)} out per M
                  </span>
                ) : (
                  <span className="rounded-full border border-hair px-1.5 py-px text-[11px] text-t3">Not priced</span>
                )}
                {admin && open !== m.model && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setOpen(m.model);
                      setInput(m.price ? String(m.price.input) : '0');
                      setOutput(m.price ? String(m.price.output) : '0');
                      setProblem(undefined);
                    }}
                  >
                    {m.price ? 'Change price' : 'Set a price'}
                  </Button>
                )}
              </div>
              {admin && open === m.model && (
                <div className="flex flex-wrap items-center gap-2">
                  <Input value={input} onChange={(e) => setInput(e.target.value)} inputMode="decimal" aria-label={`Input price for ${m.model}`} className="h-8 w-24 px-2 text-right font-mono text-[12px]" />
                  <span className="text-[12px] text-t3">in $/M</span>
                  <Input value={output} onChange={(e) => setOutput(e.target.value)} inputMode="decimal" aria-label={`Output price for ${m.model}`} className="h-8 w-24 px-2 text-right font-mono text-[12px]" />
                  <span className="text-[12px] text-t3">out $/M</span>
                  <Button size="sm" variant="primary" loading={busy} onClick={() => submit(m.model)}>
                    Save price
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setOpen(undefined)}>
                    Cancel
                  </Button>
                  {problem && <span className="text-[12px] text-rd">{problem}</span>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
