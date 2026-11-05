/**
 * Tool access by caller (docs/agents.md "Tool access"): what an agent may do depends on who is asking. An agent's own rules are
 * the default adapter of the policy port; an external policy engine (OPA, OpenFGA) can answer as well
 * (lib/server/agents/policy.ts), and the most restrictive answer wins.
 */
import type { SessionSource } from './agents';

export type AccessEffect = 'allow' | 'ask' | 'deny';

/** Who a rule is for. Every field given must match; a rule with none matches everyone. */
export interface AccessWho {
  /** A user's role (owner, admin, editor…): only people signed in to Landflow have one. */
  role?: string;
  /** One user's id. */
  user?: string;
  /** Where the request came from: the test chat, a schedule, a chat app, a workflow, the API. */
  source?: SessionSource;
}

export interface AccessRule {
  id: string;
  /** A tool's name as the model sees it, or `*` for every tool. */
  tool: string;
  who: AccessWho;
  effect: AccessEffect;
}

export interface AgentAccess {
  /** The first rule that matches the caller and the tool decides; no match means allow. */
  rules: AccessRule[];
}

export interface Caller {
  /** `session.userId`: a Landflow user id, `workflow:<id>`, a chat app's user, `schedule`… */
  id: string;
  role?: string;
  source: SessionSource;
}

export interface ToolDecision {
  effect: AccessEffect;
  /** Why, in a few words: shown in the session when a tool is withheld or needs approval. */
  reason?: string;
}

const EFFECTS: readonly AccessEffect[] = ['allow', 'ask', 'deny'];
const RESTRICTION: Record<AccessEffect, number> = { allow: 0, ask: 1, deny: 2 };

/** A clean access setting; `undefined` when there are no rules (nothing to keep). */
export function cleanAccess(input: Partial<AgentAccess> | undefined): AgentAccess | undefined {
  const rules = (input?.rules ?? []).flatMap((rule, index): AccessRule[] => {
    const tool = String(rule?.tool ?? '').trim();
    if (!tool || !EFFECTS.includes(rule.effect)) return [];
    const who: AccessWho = {
      ...(rule.who?.role?.trim() && { role: rule.who.role.trim() }),
      ...(rule.who?.user?.trim() && { user: rule.who.user.trim() }),
      ...(rule.who?.source && { source: rule.who.source }),
    };
    return [{ id: rule.id || `rule_${index}`, tool, who, effect: rule.effect }];
  });
  return rules.length ? { rules: rules.slice(0, 100) } : undefined;
}

export function whoMatches(who: AccessWho, caller: Caller): boolean {
  return (!who.role || who.role === caller.role) && (!who.user || who.user === caller.id) && (!who.source || who.source === caller.source);
}

/** The first rule that matches decides; no rule means allow. */
export function decideByRules(access: AgentAccess | undefined, caller: Caller, tool: string): ToolDecision {
  const rule = access?.rules.find((r) => (r.tool === '*' || r.tool === tool) && whoMatches(r.who, caller));
  return rule ? { effect: rule.effect, reason: `rule: ${rule.effect} ${rule.tool === '*' ? 'every tool' : rule.tool}` } : { effect: 'allow' };
}

/** Of several answers, the most restrictive: deny, then ask, then allow. */
export function mostRestrictive(decisions: ToolDecision[]): ToolDecision {
  return decisions.reduce<ToolDecision>((worst, d) => (RESTRICTION[d.effect] > RESTRICTION[worst.effect] ? d : worst), { effect: 'allow' });
}
