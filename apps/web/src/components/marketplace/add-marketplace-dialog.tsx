'use client';
/** "Add marketplace": a GitHub repo, a github.com URL or a marketplace.json URL, with preset chips. */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Store, X } from 'lucide-react';
import { api } from '@/lib/client/api';
import type { MarketplaceSummary } from '@/lib/shared/marketplace';
import { Button } from '../ui/button';
import { FieldLabel, Input } from '../ui/inputs';
import type { Preset } from './use-marketplace';

export function AddMarketplaceDialog({ presets, onClose, onAdded }: { presets: Preset[]; onClose: () => void; onAdded: (marketplace: MarketplaceSummary) => void }) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const add = async (value = input) => {
    if (!value.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const { marketplace } = await api<{ marketplace: MarketplaceSummary }>('/api/marketplaces', { method: 'POST', json: { input: value } });
      onAdded(marketplace);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-6 animate-in" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="add-marketplace-title" onMouseDown={(e) => e.stopPropagation()} className="flex w-[520px] max-w-full flex-col overflow-hidden rounded-2xl border border-hair bg-sf shadow-pop animate-panel">
        <header className="flex items-center gap-3 border-b border-hair px-5 py-3.5">
          <span className="grid size-8 place-items-center rounded-[28%] border border-hair bg-acdim text-ac">
            <Store className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="add-marketplace-title" className="text-[15px] font-semibold text-t1">
              Add marketplace
            </h2>
            <p className="text-[12px] text-t3">Claude Code plugin marketplaces: their agents and skills install into Landflow.</p>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </header>
        <div className="flex flex-col gap-4 px-5 py-4">
          <div>
            <FieldLabel>Popular</FieldLabel>
            <div className="flex flex-wrap gap-2">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  disabled={preset.added || busy}
                  onClick={() => {
                    setInput(preset.input);
                    void add(preset.input);
                  }}
                  title={preset.added ? 'Already added' : preset.description}
                  className="inline-flex items-center gap-1.5 rounded-full border border-hair bg-wl px-3 py-1 text-[12px] text-t1 transition-colors hover:border-ac hover:text-ac disabled:cursor-default disabled:opacity-60 disabled:hover:border-hair disabled:hover:text-t1"
                >
                  {preset.added && <Check className="size-3.5 text-gn" />}
                  {preset.label}
                  <span className="font-mono text-[11px] text-t3">{preset.input}</span>
                </button>
              ))}
            </div>
          </div>
          <div>
            <label htmlFor="marketplace-input">
              <FieldLabel>Repository or URL</FieldLabel>
            </label>
            <Input
              id="marketplace-input"
              ref={field}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void add()}
              placeholder="owner/repo, owner/repo@v1.2, https://github.com/… or …/marketplace.json"
              className="font-mono text-[12px]"
            />
            <p className="mt-1.5 text-[12px] leading-snug text-t3">
              The repository needs a <code className="rounded border border-hair bg-wl px-1 font-mono text-[11px]">.claude-plugin/marketplace.json</code>. Public GitHub repos work without a token; set{' '}
              <code className="rounded border border-hair bg-wl px-1 font-mono text-[11px]">GITHUB_TOKEN</code> on the host for higher rate limits.
            </p>
          </div>
          {error && <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2 text-[12px] text-rd">{error}</div>}
        </div>
        <footer className="flex justify-end gap-2 border-t border-hair px-5 py-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void add()} loading={busy} disabled={!input.trim()}>
            Add marketplace
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
