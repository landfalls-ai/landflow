/**
 * The agent builder's navigation as plain data: the three tabs, where older links land, the Abilities rows and the two Add menus.
 * No React here, so the tests (and the server page) can use it.
 */
export const BUILDER_TABS = ['persona', 'abilities', 'activity'] as const;
export type BuilderTab = (typeof BUILDER_TABS)[number];
export const TAB_LABEL: Record<BuilderTab, string> = { persona: 'Persona', abilities: 'Abilities', activity: 'Activity' };

export const ACTIVITY_VIEWS = ['sessions', 'evaluations'] as const;
export type ActivityView = (typeof ACTIVITY_VIEWS)[number];

/** The rows of the Abilities navigation, in the order a request meets them. */
export const ABILITY_ROWS = ['model', 'capabilities', 'triggers', 'guardrails', 'deploy', 'advanced'] as const;
export type AbilityRow = (typeof ABILITY_ROWS)[number];
export const ABILITY_LABEL: Record<AbilityRow, string> = {
  model: 'Model',
  capabilities: 'Capabilities',
  triggers: 'Triggers',
  guardrails: 'Guardrails',
  deploy: 'Deploy',
  advanced: 'Advanced',
};

export interface TabTarget {
  tab: BuilderTab;
  /** The Abilities row to open. */
  open?: AbilityRow;
  /** The Activity sub-view. */
  view?: ActivityView;
}

/** Where a `?tab=` value, current or from an older build, lands. A session id alone means the Sessions view. */
export function mapLegacyTab(tab?: string, session?: string, view?: string): TabTarget {
  const activityView = (ACTIVITY_VIEWS as readonly string[]).includes(view ?? '') ? (view as ActivityView) : undefined;
  switch (tab) {
    case 'persona':
    case 'build':
      return { tab: 'persona' };
    case 'abilities':
      return { tab: 'abilities' };
    case 'deploy':
      return { tab: 'abilities', open: 'deploy' };
    case 'safety':
    case 'settings':
      return { tab: 'abilities', open: 'guardrails' };
    case 'sessions':
      return { tab: 'activity', view: 'sessions' };
    case 'evaluations':
      return { tab: 'activity', view: 'evaluations' };
    case 'activity':
      return { tab: 'activity', view: activityView ?? 'sessions' };
    default:
      return session ? { tab: 'activity', view: 'sessions' } : { tab: 'persona' };
  }
}

/** The Abilities row a card's element id (`section-…`) belongs to. */
export function rowOfSection(section?: string): AbilityRow | undefined {
  switch (section) {
    case 'section-model':
      return 'model';
    case 'section-capabilities':
      return 'capabilities';
    case 'section-guardrails':
      return 'guardrails';
    case 'section-router':
    case 'section-cache':
    case 'section-access':
      return 'advanced';
    default:
      return undefined;
  }
}

/** The kagent card needs a kagent cluster credential, or an agent that already runs there. */
export function showKagent(credentials: ReadonlyArray<{ type: string }> | undefined, deployed = false): boolean {
  return deployed || (credentials ?? []).some((c) => c.type === 'core.kagentApi');
}

/** The rows the navigation shows: Deploy is only there with kagent to deploy to. */
export function abilityRows(kagent: boolean): AbilityRow[] {
  return ABILITY_ROWS.filter((row) => row !== 'deploy' || kagent);
}

export const CAPABILITY_KINDS = ['pick-node', 'workflow', 'agent', 'mcp', 'github', 'a2a', 'knowledge', 'plugin', 'skill'] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];
/** The one "Add capability" menu. */
export const CAPABILITY_MENU: Array<{ kind: CapabilityKind; label: string }> = [
  { kind: 'pick-node', label: 'Tool' },
  { kind: 'workflow', label: 'Workflow' },
  { kind: 'agent', label: 'Sub-agent' },
  { kind: 'mcp', label: 'MCP server' },
  { kind: 'github', label: 'GitHub MCP' },
  { kind: 'a2a', label: 'A2A agent' },
  { kind: 'knowledge', label: 'Knowledge base' },
  { kind: 'plugin', label: 'Plugin' },
  { kind: 'skill', label: 'Skill' },
];

export const TRIGGER_KINDS = ['schedule', 'telegram', 'slack', 'teams'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];
/** The one "Add trigger" menu. */
export const TRIGGER_MENU: Array<{ kind: TriggerKind; label: string }> = [
  { kind: 'schedule', label: 'Schedule' },
  { kind: 'telegram', label: 'Telegram' },
  { kind: 'slack', label: 'Slack' },
  { kind: 'teams', label: 'Teams' },
];

/** The header's publish button says the whole publish state: "Publish", "Publish v4" or "Live v3". */
export function publishLabel(published: { version: number } | undefined, changed: boolean, nextVersion: number): string {
  if (!published) return 'Publish';
  return changed ? `Publish v${nextVersion}` : `Live v${published.version}`;
}
