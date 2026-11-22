/**
 * C22: robots.txt, as much of RFC 9309 as a polite crawler needs: groups of `User-agent` lines, `Allow` and `Disallow` rules with `*`
 * and a closing `$`, the longest matching rule wins and Allow wins a tie, our own group (`Landflow-KnowledgeSync`) before `*`.
 * Comments and case are ignored. No file (or one with no rules for us) allows everything.
 */
export const CRAWL_AGENT = 'Landflow-KnowledgeSync';

interface Rule {
  allow: boolean;
  pattern: string;
}
interface Group {
  agents: string[];
  rules: Rule[];
}
export interface RobotsRules {
  groups: Group[];
}

export function parseRobots(text: string): RobotsRules {
  const groups: Group[] = [];
  let current: Group | undefined;
  let collecting = false; // the last line was a User-agent line: the next one joins the same group
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (!collecting || !current) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      collecting = true;
    } else if ((field === 'allow' || field === 'disallow') && current) {
      collecting = false;
      if (value) current.rules.push({ allow: field === 'allow', pattern: value }); // an empty Disallow allows everything: no rule
    } else {
      collecting = false;
    }
  }
  return { groups };
}

/** Longest rule pattern and path kept: a longer rule is ignored (a hostile file), a longer path is cut (the rules rarely reach that far). */
const MAX_PATTERN = 1024;
const MAX_PATH = 4096;

/**
 * Whether a rule's pattern matches the start of `path` (`*` any run, a final `$` the end). Linear: the pattern is cut at its stars
 * and each piece is looked for in order with indexOf, the first at the start, the last at the end when `$` closes the pattern. No
 * regular expression, so no pattern can make it backtrack.
 */
export function patternMatches(pattern: string, path: string): boolean {
  if (pattern.length > MAX_PATTERN) return false;
  const text = path.length > MAX_PATH ? path.slice(0, MAX_PATH) : path;
  const anchored = pattern.endsWith('$');
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split('*');
  if (parts.length === 1) return anchored ? text === parts[0] : text.startsWith(parts[0]);
  if (!text.startsWith(parts[0])) return false;
  let at = parts[0].length;
  for (let i = 1; i < parts.length - 1; i++) {
    const found = text.indexOf(parts[i], at);
    if (found < 0) return false;
    at = found + parts[i].length;
  }
  const last = parts[parts.length - 1];
  if (!last) return true;
  if (anchored) return text.length - last.length >= at && text.endsWith(last);
  return text.indexOf(last, at) >= 0;
}

/** The rules that apply to `agent`: every group naming it (a substring of the agent's product name), else the `*` groups. */
function rulesFor(rules: RobotsRules, agent: string): Rule[] {
  const name = agent.toLowerCase();
  const own = rules.groups.filter((g) => g.agents.some((a) => a !== '*' && a && name.includes(a)));
  const chosen = own.length ? own : rules.groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

/** Whether `agent` may fetch `pathAndQuery` (`/docs/a?x=1`). */
export function robotsAllow(rules: RobotsRules, pathAndQuery: string, agent: string = CRAWL_AGENT): boolean {
  let best: { length: number; allow: boolean } | undefined;
  for (const rule of rulesFor(rules, agent)) {
    if (!patternMatches(rule.pattern, pathAndQuery)) continue;
    const length = rule.pattern.length;
    if (!best || length > best.length || (length === best.length && rule.allow)) best = { length, allow: rule.allow };
  }
  return best ? best.allow : true;
}
