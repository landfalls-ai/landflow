'use client';
/** SB19: Spotlight's model for this session (desktop only; a phone uses the default). */
import { useEffect } from 'react';
import { loadWhenWide, useSpotlightModel } from '../spotlight-model';

/** The panel's md breakpoint, where the desktop header (and so the picker) shows. */
const WIDE = '(min-width: 768px)';

export function ModelPicker() {
  const { pick, default: fallback, models, load, setPick } = useSpotlightModel();
  // The picker is hidden on a phone (it uses the default), so the list is not fetched there; it is, once the window reaches md.
  useEffect(() => loadWhenWide(window.matchMedia(WIDE), load), [load]);
  if (models.length < 2) return null;
  return (
    <label className="flex h-8 items-center gap-2 px-3 text-[12px] text-t3">
      <span className="shrink-0">Model</span>
      <select
        value={pick ?? ''}
        onChange={(e) => setPick(e.target.value || undefined)}
        aria-label="Model for this conversation"
        title="The model Spotlight thinks with in this tab. Reload to go back to the default."
        className="h-6 min-w-0 flex-1 truncate rounded-md border border-hair bg-wl px-1.5 text-[12px] text-t2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ac"
      >
        <option value="">{`Default (${fallback ?? '…'})`}</option>
        {models.filter((m) => m.id !== fallback).map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
            {m.local ? '' : m.source === 'gateway' ? ' · gateway' : ` · ${m.source}`}
          </option>
        ))}
      </select>
    </label>
  );
}
