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
  /^(?:it )?(?:has|have) no access to (?:any )?data$/i,
  /^(?:it )?(?:cannot|can['’]t|can not) look (?:anything|data) up$/i,
];
const LEAD = /^\s*(?:\d+[.)]|[-*•])\s*/;
export const isDenial = (sentence: string): boolean => {
  const bare = sentence.replace(LEAD, '').trim().replace(/[.!]+$/, '').trim();
  return DENIALS.some((d) => d.test(bare));
};

/** True when a case's text asserts the same denial (a case that tests text-only behaviour). */
export const assertsNoLookup = (text: string): boolean => /\b(?:only|just) (?:the )?text\b|\bwithout (?:looking up|any lookups?|querying)\b|\b(?:does not|doesn['’]t|never|must not) (?:look up|claim to have looked up|query)\b|\bno (?:lookups?|data access)\b/i.test(text);

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
        if (!assertsNoLookup(`${e.user} ${e.assistant}`) && !isDenial(e.assistant)) return true;
        lines.push(`Persona: removed example ${quote(e.user)}`);
        return false;
      });
    }
  }
  const instructions = designed.instructions === undefined ? undefined : withoutDenials(designed.instructions, (s) => lines.push(`Instructions: removed ${quote(s)}`));
  if (!lines.length) return nothing;
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
