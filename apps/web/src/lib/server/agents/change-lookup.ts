/**
 * Final live run 2 (reviewed): a change that gives an agent a data or knowledge tool must not leave a line that says, with nothing
 * else in it, that the agent looks nothing up ("Never claim to have looked up data.", "Uses only the text it receives."). Only a
 * sentence that is nothing but that denial goes; one with a qualifier or scope ("… data you did not query", "Do not access databases
 * other than the sales one", "Never read data from the HR table") is a real rule and stays, and so does every other sentence of its
 * paragraph or of the mission. Everything else that contradicts the tool is the architect's to rewrite (its prompt says so).
 * The eval cases that assert the same denial are named by id, so Apply replaces only those. Pure: the design route calls it.
 */
type Tool = { id?: string; type?: string; nodeType?: string; name?: string };
type Persona = { mission?: string; whatIDo?: string[]; always?: string[]; never?: string[]; examples?: Array<{ user: string; assistant: string }> } & Record<string, unknown>;
type Config = { tools?: unknown; instructions?: string; persona?: Persona } & Record<string, unknown>;

/** A sentence that is only the denial: the whole sentence, no qualifier. */
const DENIALS = [
  /^never claims? to have (?:looked up|checked|queried) (?:any )?data$/i,
  /^(?:it )?uses? only the text (?:it receives|it is given|you (?:are given|receive))$/i,
  /^(?:do not|don['’]t|never) (?:look up|query|access) (?:any )?data$/i,
  // Re-review finding 2: "Use only the figures given in the message." and "Never claim to access databases or other data."
  /^(?:it )?uses? only the (?:figures|numbers|values|data|facts) (?:(?:that (?:are|is) |it (?:is |was )?)?(?:given|provided|supplied|sent)|(?:it|you) (?:receives?|(?:are|is) given))(?: (?:in|by|with) (?:the|this|your) (?:message|text|input|request|prompt))?$/i,
  /^(?:do not|don['’]t|never) claims? to (?:have )?(?:access(?:ed)?|querie?d?|read|look(?:ed)? up|check(?:ed)?) (?:to )?(?:any )?(?:databases?|data)(?: or (?:any )?other data)?$/i,
  /^(?:it )?(?:has|have) no access to (?:any )?data$/i,
  /^(?:it )?(?:cannot|can['’]t|can not) look (?:anything|data) up$/i,
  // First person, as a persona example's answer is written: "I can not look anything up."
  /^i (?:cannot|can['’]t|can not|am (?:not able|unable) to) look (?:anything|data|things|it) up$/i,
  /^i (?:cannot|can['’]t|can not|am (?:not able|unable) to) look up (?:any )?data$/i,
  /^i (?:do not|don['’]t) have (?:any )?access to (?:any )?data$/i,
  /^i (?:only )?use only the text (?:i receive|i am given|you give me)$/i,
];
const LEAD = /^\s*(?:\d+[.)]|[-*•])\s*/;
export const isDenial = (sentence: string): boolean => {
  const bare = sentence.replace(LEAD, '').trim().replace(/[.!]+$/, '').trim();
  return DENIALS.some((d) => d.test(bare));
};

/**
 * The fallback for a case the design did not name: its expected answer is nothing but denial sentences ("Never claims to have looked
 * up data."). It reads `expected` only, whole sentences only: a case that merely mentions text, lookups or safety is not caught.
 */
export const expectsOnlyDenial = (expected: string | undefined): boolean => {
  // A sentence may join two denials ("I use only the text you give me, so I cannot look up data."): each clause must be one.
  const clauses = (expected ?? '').split(/(?<=[.!?])\s+|\n+/).flatMap((x) => x.split(/,\s+(?:so|and)\s+|;\s+/)).map((x) => x.trim()).filter(Boolean);
  return clauses.length > 0 && clauses.every(isDenial);
};

/** How many denial sentences or lines a config holds (instructions, persona lists, mission): a rewrite that has fewer removed some. */
export function denialCount(config: Config): number {
  const sentences = (text: string | undefined) => (text ?? '').split('\n').flatMap((line) => line.replace(LEAD, '').split(/(?<=[.!?])\s+/));
  const p = config.persona;
  const lines = [...(p?.always ?? []), ...(p?.never ?? []), ...(p?.whatIDo ?? [])];
  return [...sentences(config.instructions), ...sentences(p?.mission), ...lines].filter(isDenial).length + (p?.examples ?? []).filter((e) => isDenial(e.assistant)).length;
}

const isData = (t: Tool) => t.type === 'knowledge' || (t.type === 'node' && /^databases\./.test(t.nodeType ?? ''));

/** The data or knowledge tools this change adds. */
export function addedDataTools(base: Config, designed: Config): Tool[] {
  const had = new Set(((Array.isArray(base.tools) ? base.tools : []) as Tool[]).map((t) => t.id));
  return ((Array.isArray(designed.tools) ? designed.tools : []) as Tool[]).filter((t) => !had.has(t.id) && isData(t));
}

export interface LookupChange {
  config: Config;
  /** Card lines: "Instructions: removed “…”", "Persona: removed “…”", "Persona: removed example “…”". */
  lines: string[];
  /** The tool names, for new cases. */
  tools: string[];
  /** Whether any denial was removed (new cases are offered only then). */
  removed: boolean;
}

const quote = (line: string) => `“${line.length > 70 ? `${line.slice(0, 69)}…` : line}”`;
const sentencesOf = (text: string) => text.split(/(?<=[.!?])\s+/);

/** `text` without its denial sentences: a line that is only one goes; in a longer line just that sentence goes, the rest and its spacing stay. */
function withoutDenials(text: string, say: (sentence: string) => void): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const lead = LEAD.exec(line)?.[0] ?? '';
    const parts = line.slice(lead.length).split(/(?<=[.!?])(\s+)/); // sentence, gap, sentence, gap…
    let kept = '';
    let changed = false;
    for (let i = 0; i < parts.length; i += 2) {
      if (isDenial(parts[i])) {
        say(parts[i].trim());
        changed = true;
        continue;
      }
      kept += (kept ? (parts[i - 1] ?? ' ') : '') + parts[i];
    }
    if (!changed) out.push(line);
    else if (kept.trim()) out.push(lead + kept.trim());
  }
  return out.join('\n');
}

export function reconcileLookup(base: Config, designed: Config): LookupChange {
  const added = addedDataTools(base, designed);
  const nothing = { config: designed, lines: [] as string[], tools: [] as string[], removed: false };
  if (!added.length) return nothing;
  const lines: string[] = [];
  const persona = designed.persona ? { ...designed.persona } : undefined;
  if (persona) {
    for (const key of ['always', 'never', 'whatIDo'] as const) {
      const list = persona[key];
      if (!list) continue;
      const kept = list.filter((line) => {
        if (!isDenial(line)) return true;
        lines.push(`Persona: removed ${quote(line)}`);
        return false;
      });
      if (kept.length) persona[key] = kept;
      else delete persona[key];
    }
    if (persona.mission) {
      const next = withoutDenials(persona.mission, (s) => lines.push(`Persona: removed ${quote(s)}`));
      if (next.trim()) persona.mission = next;
      else delete persona.mission;
    }
    if (persona.examples) {
      persona.examples = persona.examples.filter((e) => {
        if (!expectsOnlyDenial(e.assistant)) return true;
        lines.push(`Persona: removed example ${quote(e.user)}`);
        return false;
      });
      if (!persona.examples.length) delete persona.examples; // an empty list is no list
    }
  }
  const instructions = designed.instructions === undefined ? undefined : withoutDenials(designed.instructions, (s) => lines.push(`Instructions: removed ${quote(s)}`));
  // The design may have rewritten the denial away itself (nothing left for this function to remove): the base had more denials than the design has.
  const rewritten = denialCount(base) > denialCount(designed);
  if (!lines.length) return rewritten ? { ...nothing, tools: added.map((t) => t.name).filter((n): n is string => Boolean(n)), removed: true } : nothing;
  return { config: { ...designed, ...(persona && { persona }), ...(instructions !== undefined && { instructions }) }, lines, tools: added.map((t) => t.name).filter((n): n is string => Boolean(n)), removed: true };
}

/** The cases that replace the ones that asserted the denial: generic, answerable with the tool. */
export function lookupCases(tools: string[], data: boolean): Array<{ input: string; expected: string }> {
  const names = tools.join(' and ') || 'its tool';
  return data
    ? [
        { input: 'Read a few rows with your data tool and tell me what they show.', expected: `Uses ${names}, reports what it returned and where it came from, and says so when nothing is found.` },
        { input: 'Look up the data you need for this and report what you found.', expected: `Uses ${names} to read the data and reports it without making anything up.` },
      ]
    : [
        { input: 'Search your knowledge base and tell me what it says about its main topic.', expected: `Searches ${names}, answers from what it found and says so when it finds nothing.` },
        { input: 'Find the passage that answers this and quote it.', expected: `Uses ${names} to search, then quotes or summarises the passage it found.` },
      ];
}
