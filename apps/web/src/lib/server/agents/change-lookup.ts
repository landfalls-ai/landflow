/**
 * Final live run 2: a change that gives an agent a data or knowledge tool must not leave the agent saying it cannot look anything up.
 * "Uses only the text it receives" and "Never claim to have looked up data" stay in the persona and the steps after an agent fix adds
 * SQLite, so the next review asked to take the tool out again, and the eval cases still tested text-only answers (the Publish gate
 * held at 2.0 / 5). This removes those lines and, when it did, replaces the cases that test the old behaviour with ones the tool can answer.
 * Pure: the design route calls it with the base and the designed config.
 */
type Tool = { id?: string; type?: string; nodeType?: string; name?: string };
type Persona = { mission?: string; whatIDo?: string[]; always?: string[]; never?: string[]; examples?: Array<{ user: string; assistant: string }> } & Record<string, unknown>;
type Config = { tools?: unknown; instructions?: string; persona?: Persona } & Record<string, unknown>;

/** A line that says the agent has no data to read. */
export const NO_LOOKUP = /\b(?:uses? only the text (?:it|you) (?:receives?|are given|is given|get)|only (?:uses? )?the text (?:it|you) (?:receives?|are given|get)|never claims? to have (?:looked up|checked|queried|read)|(?:do(?:es)? not|don['’]t|doesn['’]t|never|cannot|can['’]t) (?:look up|lookup|query|access|read|fetch) (?:any )?(?:data|databases?|figures|numbers|records)|no (?:access to|lookups? of) (?:data|databases?))\b/i;

const isData = (t: Tool) => t.type === 'knowledge' || (t.type === 'node' && /^databases\./.test(t.nodeType ?? ''));

/** The data or knowledge tools this change adds. */
export function addedDataTools(base: Config, designed: Config): Tool[] {
  const had = new Set(((Array.isArray(base.tools) ? base.tools : []) as Tool[]).map((t) => t.id));
  return ((Array.isArray(designed.tools) ? designed.tools : []) as Tool[]).filter((t) => !had.has(t.id) && isData(t));
}

export interface LookupChange {
  config: Config;
  /** Card lines: "Instructions: removed “…”", "Persona: removed “…”". */
  lines: string[];
  /** Cases an agent answerable with its new tool; empty when nothing contradicted the tool. */
  cases: Array<{ input: string; expected: string }>;
}

const quote = (line: string) => `“${line.length > 70 ? `${line.slice(0, 69)}…` : line}”`;

export function reconcileLookup(base: Config, designed: Config): LookupChange {
  const added = addedDataTools(base, designed);
  if (!added.length) return { config: designed, lines: [], cases: [] };
  const lines: string[] = [];
  const keep = (list: string[] | undefined, where: string) => {
    if (!list) return list;
    const kept = list.filter((line) => {
      if (!NO_LOOKUP.test(line)) return true;
      lines.push(`${where}: removed ${quote(line)}`);
      return false;
    });
    return kept;
  };
  const persona = designed.persona ? { ...designed.persona } : undefined;
  if (persona) {
    for (const key of ['always', 'never', 'whatIDo'] as const) {
      const next = keep(persona[key], 'Persona');
      if (next) persona[key] = next;
      if (persona[key] && !persona[key]!.length) delete persona[key];
    }
    if (persona.mission && NO_LOOKUP.test(persona.mission)) {
      lines.push(`Persona: removed ${quote(persona.mission)}`);
      delete persona.mission;
    }
    if (persona.examples) persona.examples = persona.examples.filter((e) => !NO_LOOKUP.test(`${e.user} ${e.assistant}`));
  }
  const instructions = designed.instructions === undefined ? undefined : designed.instructions.split('\n').filter((line) => {
    if (!NO_LOOKUP.test(line)) return true;
    lines.push(`Instructions: removed ${quote(line.trim())}`);
    return false;
  }).join('\n');
  if (!lines.length) return { config: designed, lines, cases: [] };
  const names = added.map((t) => t.name).filter(Boolean).join(' and ') || 'its tool';
  const data = added.some((t) => t.type === 'node');
  const cases = data
    ? [
        { input: 'What were last month’s sales by region? Read the figures with your data tool.', expected: `Calls ${names}, then reports the figures it returned by region; it does not make up numbers.` },
        { input: 'Look the latest numbers up and tell me what you found.', expected: `Uses ${names} to read the data and reports the figures it found, saying where they came from.` },
      ]
    : [
        { input: 'What does your knowledge base say about its main topic?', expected: `Searches ${names} and answers from what it found, saying so when it finds nothing.` },
        { input: 'Find the passage that answers this and quote it: what does it cover?', expected: `Uses ${names} to search, then quotes or summarises the passage it found.` },
      ];
  return { config: { ...designed, ...(persona && { persona }), ...(instructions !== undefined && { instructions }) }, lines, cases };
}
