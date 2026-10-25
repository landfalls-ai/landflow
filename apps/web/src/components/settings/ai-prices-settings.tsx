'use client';
/**
 * Settings → AI prices: the price table AI costs are estimated with (token & cost tracking, the caps in workflow
 * and agent settings, Insights). Built-in list prices for Anthropic and OpenAI, read-only, and the instance's
 * overrides, which win per model. USD per million tokens; a model id also prices ids that start with it.
 */
import { useEffect, useMemo, useState } from 'react';
import { CircleDollarSign, Plus, Save, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { can } from '@/lib/shared/auth';
import type { ModelPrice, PriceTable } from '@/lib/shared/ai-usage';
import { useViewer } from '@/components/auth/viewer';
import { Card } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Input, SectionLabel } from '@/components/ui/inputs';

/** An override row as typed (numbers kept as text until saved). */
interface Row {
  key: number;
  provider: string;
  model: string;
  input: string;
  output: string;
}

let nextKey = 1;
const toRow = (price: ModelPrice): Row => ({ key: nextKey++, provider: price.provider, model: price.model, input: String(price.input), output: String(price.output) });
const usd = (value: number) => `$${value.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;

/** The rows as prices, or the first problem. */
function parse(rows: Row[]): { prices: ModelPrice[] } | { error: string } {
  const prices: ModelPrice[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const provider = row.provider.trim().toLowerCase();
    const model = row.model.trim();
    if (!provider && !model && !row.input.trim() && !row.output.trim()) continue;
    if (!provider || !model) return { error: 'Every override needs a provider and a model' };
    const input = Number(row.input);
    const output = Number(row.output);
    if (row.input.trim() === '' || row.output.trim() === '' || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
      return { error: `${provider}/${model}: prices are USD per million tokens, 0 or more` };
    }
    const id = `${provider}/${model.toLowerCase()}`;
    if (seen.has(id)) return { error: `${provider}/${model} is listed twice` };
    seen.add(id);
    prices.push({ provider, model, input, output });
  }
  return { prices };
}

export function AiPricesSettings() {
  const viewer = useViewer();
  const admin = can(viewer, 'settings:manage');
  const [table, setTable] = useState<PriceTable>();
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const apply = (next: PriceTable) => {
    setTable(next);
    setRows(next.overrides.map(toRow));
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
          USD per million tokens. Your prices win over the built-in ones. A model id also prices the ids that start with it (<code className="font-mono">claude-sonnet-5-5</code>{' '}
          prices <code className="font-mono">claude-sonnet-5-5-20261001</code>). Ollama and other local models cost $0 unless you price them here — e.g. to count
          electricity or hardware. Costs are estimates; your provider’s bill is what counts.
        </p>
        {rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-[13px]">
              <thead>
                <tr className="text-left text-[12px] text-t2">
                  <th className="pb-1.5 pr-2 font-semibold">Provider</th>
                  <th className="pb-1.5 pr-2 font-semibold">Model (or prefix)</th>
                  <th className="pb-1.5 pr-2 text-right font-semibold">Input $/M</th>
                  <th className="pb-1.5 pr-2 text-right font-semibold">Output $/M</th>
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
              {['anthropic', 'openai', 'ollama'].map((p) => (
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
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <SectionLabel>Built-in prices</SectionLabel>
          <span className="text-[12px] text-t3">List prices, USD per million tokens</span>
          <div className="relative ml-auto">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-t3" />
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter models" aria-label="Filter models" className="h-8 w-48 pl-8 text-[12px]" />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-hair text-left text-[12px] text-t2">
                <th className="h-8 pr-2 font-semibold">Provider</th>
                <th className="h-8 pr-2 font-semibold">Model</th>
                <th className="h-8 pr-2 text-right font-semibold">Input</th>
                <th className="h-8 pr-2 text-right font-semibold">Output</th>
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
                  <td colSpan={5} className="py-4 text-center text-[12px] text-t3">
                    No built-in price matches “{filter}”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
