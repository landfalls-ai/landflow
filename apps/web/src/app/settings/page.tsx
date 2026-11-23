'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BellRing, Braces, Building2, ChevronLeft, ChevronRight, CircleDollarSign, Cpu, Gauge, GitBranch, KeyRound, Landmark, Layers, Network, Plug, Route, ScrollText, Sparkles, ShieldCheck, SlidersHorizontal, Users, Vault } from 'lucide-react';
import { cn } from '@/lib/utils';
import { can, isBuiltInAdmin, type Action } from '@/lib/shared/auth';
import { useViewer } from '@/components/auth/viewer';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { AiCapsSettings } from '@/components/settings/ai-caps-settings';
import { AiPricesSettings } from '@/components/settings/ai-prices-settings';
import { CompanySettings } from '@/components/settings/company-settings';
import { AlertsSettings } from '@/components/settings/alerts-settings';
import { ApiKeysSettings } from '@/components/settings/api-keys-settings';
import { AuditSettings } from '@/components/settings/audit-settings';
import { EnvironmentsSettings } from '@/components/settings/environments-settings';
import { ExternalSecretsSettings } from '@/components/settings/external-secrets-settings';
import { SETTINGS_GROUPS, resolveSection, sectionFromLocation } from '@/components/settings/settings-groups';
import { GeneralSettings } from '@/components/settings/general-settings';
import { GovernanceSettings } from '@/components/settings/governance-settings';
import { LlmGatewayCard } from '@/components/settings/llm-gateway-settings';
import { McpSettings } from '@/components/settings/mcp-settings';
import { SpotlightSettings } from '@/components/settings/spotlight-settings';
import { SecuritySettings } from '@/components/settings/security-settings';
import { SourceControlSettings } from '@/components/settings/source-control-settings';
import { UsersSettings } from '@/components/settings/users-settings';
import { VariablesSettings } from '@/components/settings/variables-settings';
import { TransportsSettings } from '@/components/settings/transports-settings';
import { WorkersSettings } from '@/components/settings/workers-settings';

/** `role`: only shown to roles that `can` do it; `admin`: and only to the built-in owner or admin role (instance-wide controls, C32 review). */
const SECTIONS: readonly { id: string; label: string; icon: typeof Braces; hint: string; role?: Action; admin?: true }[] = [
  { id: 'general', label: 'General', icon: SlidersHorizontal, hint: 'Time zone and execution retention' },
  { id: 'company', label: 'Company', icon: Building2, hint: 'Name and mission' },
  { id: 'variables', label: 'Variables', icon: Braces, hint: '$vars for expressions' },
  { id: 'alerts', label: 'Alerts', icon: BellRing, hint: 'Email, Slack or webhook on failures' },
  { id: 'ai-prices', label: 'AI prices', icon: CircleDollarSign, hint: 'What a token costs, per model' },
  { id: 'ai-caps', label: 'AI caps', icon: Gauge, hint: 'Daily and monthly limits' },
  { id: 'llm-gateway', label: 'LLM gateway', icon: Route, hint: 'LiteLLM, backstop budgets' },
  { id: 'spotlight', label: 'Spotlight', icon: Sparkles, hint: 'The model Spotlight uses' },
  { id: 'mcp', label: 'MCP', icon: Plug, hint: 'Let coding agents build workflows' },
  { id: 'users', label: 'Users', icon: Users, hint: 'Invite people, change roles', role: 'users:manage' },
  { id: 'api-keys', label: 'API keys', icon: KeyRound, hint: 'For scripts, CI and the CLI' },
  { id: 'security', label: 'Security', icon: ShieldCheck, hint: 'Single sign-on and sessions', role: 'settings:manage', admin: true },
  { id: 'audit', label: 'Audit log', icon: ScrollText, hint: 'Who did what; SIEM streaming', role: 'audit:read' },
  { id: 'governance', label: 'Governance', icon: Landmark, hint: 'Allowed nodes, publish approval' },
  { id: 'source-control', label: 'Source control', icon: GitBranch, hint: 'Push and pull workflows with Git', role: 'settings:manage', admin: true },
  { id: 'environments', label: 'Environments', icon: Layers, hint: 'Promote between environments', role: 'settings:manage', admin: true },
  { id: 'external-secrets', label: 'External secrets', icon: Vault, hint: 'Vault, 1Password, cloud secret stores', role: 'settings:manage', admin: true },
  { id: 'workers', label: 'Workers', icon: Cpu, hint: 'Queue mode, workers and the leader' },
  { id: 'transports', label: 'Transports', icon: Network, hint: 'HTTP, gRPC and broker connections', role: 'settings:manage', admin: true },
];
type Section = string;

const BODIES: Record<string, () => React.ReactNode> = {
  general: () => <GeneralSettings />,
  company: () => <CompanySettings />,
  variables: () => <VariablesSettings />,
  alerts: () => <AlertsSettings />,
  'ai-prices': () => <AiPricesSettings />,
  'ai-caps': () => <AiCapsSettings />,
  'llm-gateway': () => <LlmGatewayCard />,
  spotlight: () => <SpotlightSettings />,
  mcp: () => <McpSettings />,
  users: () => <UsersSettings />,
  'api-keys': () => <ApiKeysSettings />,
  security: () => <SecuritySettings />,
  audit: () => <AuditSettings />,
  governance: () => <GovernanceSettings />,
  'source-control': () => <SourceControlSettings />,
  environments: () => <EnvironmentsSettings />,
  'external-secrets': () => <ExternalSecretsSettings />,
  workers: () => <WorkersSettings />,
  transports: () => <TransportsSettings />,
};

/** /settings (#general, #company, #variables, #alerts, #environments, #source-control, #users, #api-keys, #security, #audit, #governance, #external-secrets, #ai-prices, #ai-caps, #llm-gateway, #spotlight, #mcp, #workers, #transports; the old #api and ?section=api open the API reference on Developers, in five groups): instance settings. */
export default function SettingsPage() {
  const viewer = useViewer();
  const router = useRouter();
  const sections = SECTIONS.filter((s) => (!s.role || can(viewer, s.role)) && (!s.admin || isBuiltInAdmin(viewer)));
  const groups = SETTINGS_GROUPS.map((group) => ({ ...group, items: group.sections.map((id) => sections.find((s) => s.id === id)).filter((s) => s !== undefined) })).filter((group) => group.items.length);
  const [chosen, setSection] = useState<Section>('general');
  const section = sections.some((s) => s.id === chosen) ? chosen : 'general';
  // A phone shows the sections as a list first, and one section at a time (docs/mobile.md#settings-and-agents).
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    const known = SECTIONS.map((s) => s.id);
    const fromLocation = () => {
      const target = resolveSection(sectionFromLocation(window.location.search, window.location.hash), known);
      if (target.kind === 'redirect') {
        router.replace(target.href);
        return;
      }
      setSection(target.kind === 'section' ? target.id : 'general');
      setOpened(target.kind === 'section');
      // The query is read once: from here on the hash says where we are.
      if (target.kind === 'section' && window.location.search) window.history.replaceState(null, '', `${window.location.pathname}#${target.id}`);
    };
    fromLocation();
    window.addEventListener('hashchange', fromLocation);
    return () => window.removeEventListener('hashchange', fromLocation);
  }, [router]);

  const choose = (id: Section) => {
    setSection(id);
    setOpened(true);
    window.history.replaceState(null, '', `${window.location.pathname}#${id}`);
  };
  const backToList = () => {
    setOpened(false);
    window.history.replaceState(null, '', window.location.pathname);
  };

  return (
    <>
      <PageHeader title="Settings" meta={<span>Instance-wide</span>} />
      <PageBody className="grid max-w-[1080px] grid-cols-1 gap-6 md:grid-cols-[240px_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className={cn('flex flex-col gap-4 max-md:gap-5', opened && 'max-md:hidden')}>
          {groups.map((group) => (
            <div key={group.id} role="group" aria-labelledby={`settings-group-${group.id}`}>
              <h3 id={`settings-group-${group.id}`} className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3 max-md:px-4">
                {group.label}
              </h3>
              <div className="flex flex-col gap-1 max-md:gap-0 max-md:overflow-hidden max-md:rounded-2xl max-md:border max-md:border-hair max-md:bg-sf">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = section === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => choose(item.id)}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-[120ms] max-md:items-center max-md:gap-3 max-md:rounded-none max-md:border-b max-md:border-hair max-md:px-4 max-md:py-3 max-md:last:border-b-0',
                        active ? 'bg-acdim max-md:bg-transparent' : 'hover:bg-acdim',
                      )}
                    >
                      <Icon className={cn('mt-0.5 size-4 shrink-0', active ? 'text-t1' : 'text-t3')} strokeWidth={1.8} />
                      <span className="min-w-0 max-md:flex-1">
                        <span className={cn('block text-[13px] max-md:text-[15px] max-md:font-semibold max-md:text-t1', active ? 'font-semibold text-t1' : 'text-t2')}>{item.label}</span>
                        <span className="block truncate text-[11px] text-t3 max-md:text-[12.5px] md:hidden">{item.hint}</span>
                      </span>
                      <ChevronRight className="size-4 shrink-0 text-t3 md:hidden" aria-hidden />
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
        <section key={section} className={cn('min-w-0 animate-fade-up', !opened && 'max-md:hidden')}>
          <button type="button" onClick={backToList} className="-ml-2 mb-1 flex h-11 items-center gap-1 rounded-full px-2 text-[14px] text-t2 md:hidden">
            <ChevronLeft className="size-4" /> Settings
          </button>
          <h2 className="mb-3 text-[15px] font-semibold text-t1">{SECTIONS.find((s) => s.id === section)?.label}</h2>
          {BODIES[section]?.()}
        </section>
      </PageBody>
    </>
  );
}
