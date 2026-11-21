/**
 * The block an agent got, split for display (docs/run-trace.md#what-it-saw), and the persona summary kept beside it.
 * Pure: the browser and the runtime both use it. Never throws on any string.
 */
import type { AgentPersona } from './agents';
import { PRACTICES_HEADING } from './practices';
import { CONTEXT_FOOTER, CONTEXT_HEADING } from './project-context';
import { SAW_LINE_PREFIXES, SAW_PERSONA_MAX, type SawMemoryItem, type SawMemorySource, type SawMemorySourceKind, type SawPersona, type SawSections } from './what-it-saw';

const P = SAW_LINE_PREFIXES;
const after = (line: string, prefix: string) => line.slice(prefix.length).trim();

/** Split the text the system prompt got by the line prefixes of the project block (trimmed lines); the practices block is the tail. */
export function sawSections(text: string): SawSections {
  const out: SawSections = { goals: [], brief: [], practices: [] };
  const lines = typeof text === 'string' ? text.split(/\r?\n/) : [];
  const tail = lines.findIndex((l) => l.trim() === PRACTICES_HEADING);
  const head = tail < 0 ? lines : lines.slice(0, tail);
  if (tail >= 0) out.practices = lines.slice(tail);
  for (const raw of head) {
    const line = raw.trim();
    if (!line || line === CONTEXT_FOOTER || line.startsWith(CONTEXT_HEADING)) continue;
    if (line.startsWith(P.mission)) out.mission = after(line, P.mission);
    else if (line.startsWith(P.subGoal)) out.goals.push(line.slice(2).trim());
    else if (line.startsWith(P.goal)) out.goals.push(line);
    else if (line.startsWith(P.compactGoal)) out.goals.push(...after(line, P.compactGoal).split(' → ').map((g) => g.trim()).filter(Boolean));
    else if (line.startsWith(P.why)) out.why = after(line, P.why);
    else if (line.startsWith(P.brief)) out.brief.push(after(line, P.brief));
    else if (line.startsWith(P.words)) out.words = after(line, P.words);
    else if (line.startsWith(P.status)) out.status = after(line, P.status);
    else if (line.startsWith(P.run)) out.run = after(line, P.run);
    else out.brief.push(line);
  }
  return out;
}

const cap = (value: string | undefined) => {
  const text = value?.trim();
  if (!text) return undefined;
  return text.length <= SAW_PERSONA_MAX ? text : `${text.slice(0, SAW_PERSONA_MAX - 1).trimEnd()}…`;
};

/** The persona summary a run keeps: role, mission and what-I-do, each at most SAW_PERSONA_MAX characters; never the instructions. */
export function sawPersona(persona?: AgentPersona): SawPersona {
  const role = cap(persona?.role);
  const mission = cap(persona?.mission);
  const whatIDo = cap((persona?.whatIDo ?? []).map((l) => l.trim()).filter(Boolean).join('; '));
  return { ...(role && { role }), ...(mission && { mission }), ...(whatIDo && { whatIDo }) };
}

/** The heading of each memory source (What it saw → Memory). */
export const SAW_MEMORY_LABEL: Record<SawMemorySourceKind, string> = {
  'agent-profile': 'Profile',
  'agent-relevant': 'Relevant',
  'team-notebook': 'Team notebook',
};

/** `attrs.saw.memory` as the journal gives it (any JSON): the well-formed sources, none for a run recorded before C11 or without memory. */
export function sawMemoryOf(value: unknown): SawMemorySource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v): SawMemorySource[] => {
    if (!v || typeof v !== 'object') return [];
    const s = v as Record<string, unknown>;
    if (typeof s.source !== 'string' || !(s.source in SAW_MEMORY_LABEL) || !Array.isArray(s.items)) return [];
    const items = (s.items as unknown[]).flatMap((raw): SawMemoryItem[] => {
      if (!raw || typeof raw !== 'object' || typeof (raw as SawMemoryItem).id !== 'string') return [];
      const i = raw as Record<string, unknown>;
      return [{ id: i.id as string, ...(typeof i.version === 'number' && { version: i.version }), ...(typeof i.kind === 'string' && { kind: i.kind }), ...(i.static === true && { static: true }), ...(typeof i.score === 'number' && { score: i.score }) }];
    });
    if (!items.length && !(typeof s.count === 'number' && s.count > 0)) return [];
    return [{ source: s.source as SawMemorySourceKind, count: typeof s.count === 'number' ? s.count : items.length, items, ...((s.mode === 'meaning' || s.mode === 'keywords') && { mode: s.mode }), ...(typeof s.hash === 'string' && { hash: s.hash }) }];
  });
}
