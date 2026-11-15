/**
 * "What it saw" (docs/run-trace.md#what-it-saw): the block an agent got in one run, as sections, with its persona summary.
 * Used by the Run Trace sheet (an agent's span) and by an agent's sessions. No hooks: the exact text folds out with <details>.
 */
import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ContextMode, RunPractice } from '@/lib/shared/project-context';
import { PRACTICES_HEADING } from '@/lib/shared/practices';
import type { SawPersona } from '@/lib/shared/what-it-saw';
import { sawSections } from '@/lib/shared/what-it-saw-sections';
import { Badge } from '../ui/badge';
import { SectionTitle } from './parts';

export interface WhatItSawProps {
  mode: ContextMode;
  text: string;
  persona?: SawPersona;
  practices?: RunPractice[];
  /** Without its own title (a fold names it). */
  bare?: boolean;
}

function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{label}</div>
      <div className="mt-0.5 break-words text-[13px] text-t1">{children}</div>
    </div>
  );
}

export function WhatItSaw({ mode, text, persona, practices = [], bare }: WhatItSawProps) {
  const s = sawSections(text);
  const heading = s.practices[0]?.trim() === PRACTICES_HEADING;
  const practiceLines = (heading ? s.practices.slice(1) : s.practices).map((l) => l.trim()).filter(Boolean);
  const who = persona && (persona.role || persona.mission || persona.whatIDo) ? persona : undefined;
  return (
    <section aria-label="What it saw" data-testid="what-it-saw">
      {!bare && <SectionTitle>What it saw</SectionTitle>}
      <div className="flex flex-col gap-2.5 rounded-xl border border-hair bg-sf2 px-3 py-2.5">
        {mode === 'off' && !text && <p className="text-[13px] text-t3">Project context off for this agent</p>}
        {s.goals.length > 0 && (
          <Part label="Goal chain">
            <ol className="flex flex-col gap-0.5">
              {s.goals.map((g, i) => (
                <li key={i} style={{ paddingLeft: `${Math.min(i, 3) * 10}px` }}>
                  {i > 0 && <span className="text-t3">└ </span>}
                  {g}
                </li>
              ))}
            </ol>
            {s.why && <p className="mt-0.5 text-t2">Why: {s.why}</p>}
          </Part>
        )}
        {s.mission && <Part label="Mission">{s.mission}</Part>}
        {s.brief.length > 0 && (
          <Part label="Brief">
            {s.brief.map((l, i) => (
              <p key={i} className="whitespace-pre-wrap">
                {l}
              </p>
            ))}
          </Part>
        )}
        {s.words && <Part label="Words">{s.words}</Part>}
        {s.status && <Part label="Status">{s.status}</Part>}
        {s.run && <Part label="This run">{s.run}</Part>}
        {(practiceLines.length > 0 || practices.length > 0) && (
          <Part label="Practices">
            {practices.length > 0 && (
              <ul className="mb-1 flex flex-wrap gap-1">
                {practices.map((p) => (
                  <li key={`${p.handle}@${p.version}`} className="rounded-md border border-hair bg-sf px-1.5 py-0.5 font-mono text-[11px] text-t2">
                    {p.handle}@{p.version}
                  </li>
                ))}
              </ul>
            )}
            {practiceLines.map((l, i) => (
              <p key={i} className="whitespace-pre-wrap text-t2">
                {l}
              </p>
            ))}
          </Part>
        )}
        {/* PR09: SawPracticesRow mounts here (integrator) */}
        {who && (
          <Part label="Persona">
            {who.role && <p>{who.role}</p>}
            {who.mission && <p className="text-t2">{who.mission}</p>}
            {who.whatIDo && <p className="text-t2">Does: {who.whatIDo}</p>}
          </Part>
        )}
        {text && (
          <details className="group min-w-0">
            <summary className="flex min-h-7 cursor-pointer list-none items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3 hover:text-t2 [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3 transition-transform group-open:rotate-90" /> Show the exact text
            </summary>
            <pre className="mt-1 max-h-[40dvh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-hair bg-sf px-2.5 py-2 font-mono text-[12px] text-t2">{text}</pre>
          </details>
        )}
      </div>
    </section>
  );
}

/** `attrs.saw` as the journal gives it (any JSON), or undefined when it is not one. */
export function sawOf(value: unknown): (WhatItSawProps & { at?: string }) | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.text !== 'string' || typeof v.mode !== 'string') return undefined;
  return {
    mode: v.mode as ContextMode,
    text: v.text,
    persona: v.persona && typeof v.persona === 'object' ? (v.persona as SawPersona) : undefined,
    practices: Array.isArray(v.practices) ? (v.practices as RunPractice[]) : [],
    ...(typeof v.at === 'string' && { at: v.at }),
  };
}

/** `attrs.project` and `attrs.goal` on a run's root span, as chips. */
export function RunScopeChips({ project, goal }: { project?: unknown; goal?: unknown }) {
  const name = (v: unknown, key: 'name' | 'title') => {
    if (!v || typeof v !== 'object') return undefined;
    const o = v as { id?: unknown; name?: unknown; title?: unknown };
    const label = o[key];
    return typeof label === 'string' && label ? label : typeof o.id === 'string' ? o.id : undefined;
  };
  const p = name(project, 'name');
  const g = name(goal, 'title');
  if (!p && !g) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 pb-3" data-testid="run-scope">
      {p && <Badge tone="accent" className="max-w-full truncate" title="The project this run is in">Project: {p}</Badge>}
      {g && <Badge tone="muted" className="max-w-full truncate" title="The goal this run serves">Goal: {g}</Badge>}
    </div>
  );
}
