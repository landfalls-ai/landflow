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

/** A rule's pattern as a regular expression anchored at the start (`*` any run, a final `$` the end). */
const compile = (pattern: string): RegExp => new RegExp(`^${pattern.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\$$/, '$$')}`);

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
    if (!compile(rule.pattern).test(pathAndQuery)) continue;
    const length = rule.pattern.length;
    if (!best || length > best.length || (length === best.length && rule.allow)) best = { length, allow: rule.allow };
  }
  return best ? best.allow : true;
}
