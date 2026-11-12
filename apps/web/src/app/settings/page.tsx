'use client';
import { useEffect, useState } from 'react';
import { BellRing, BookOpen, Braces, ChevronLeft, ChevronRight, CircleDollarSign, Cpu, GitBranch, KeyRound, Landmark, Layers, Network, Plug, ScrollText, ShieldCheck, SlidersHorizontal, Users, Vault } from 'lucide-react';
import { cn } from '@/lib/utils';
import { can, type Action } from '@/lib/shared/auth';
import { useViewer } from '@/components/auth/viewer';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { AiCapsSettings } from '@/components/settings/ai-caps-settings';
import { AiPricesSettings } from '@/components/settings/ai-prices-settings';
import { AlertsSettings } from '@/components/settings/alerts-settings';
import { ApiDocs } from '@/components/settings/api-docs';
import { ApiKeysSettings } from '@/components/settings/api-keys-settings';
import { AuditSettings } from '@/components/settings/audit-settings';
import { EnvironmentsSettings } from '@/components/settings/environments-settings';
import { ExternalSecretsSettings } from '@/components/settings/external-secrets-settings';
import { GeneralSettings } from '@/components/settings/general-settings';
import { GovernanceSettings } from '@/components/settings/governance-settings';
import { McpSettings } from '@/components/settings/mcp-settings';
import { SecuritySettings } from '@/components/settings/security-settings';
import { SourceControlSettings } from '@/components/settings/source-control-settings';
import { UsersSettings } from '@/components/settings/users-settings';
import { VariablesSettings } from '@/components/settings/variables-settings';
import { TransportsSettings } from '@/components/settings/transports-settings';
import { WorkersSettings } from '@/components/settings/workers-settings';

/** `role`: only shown to roles that `can` do it. */
const SECTIONS: readonly { id: string; label: string; icon: typeof Braces; hint: string; role?: Action }[] = [
  { id: 'general', label: 'General', icon: SlidersHorizontal, hint: 'Time zone and execution retention' },
  { id: 'variables', label: 'Variables', icon: Braces, hint: '$vars for expressions' },
  { id: 'alerts', label: 'Alerts', icon: BellRing, hint: 'Email, Slack or webhook on failures' },
  { id: 'ai-prices', label: 'AI prices', icon: CircleDollarSign, hint: 'Token prices and usage caps for AI' },
  { id: 'mcp', label: 'MCP', icon: Plug, hint: 'Let coding agents build workflows' },
  { id: 'users', label: 'Users', icon: Users, hint: 'Invite people, change roles', role: 'users:manage' },
  { id: 'api-keys', label: 'API keys', icon: KeyRound, hint: 'For scripts, CI and the CLI' },
  { id: 'api', label: 'API docs', icon: BookOpen, hint: 'REST endpoints and OpenAPI' },
  { id: 'security', label: 'Security', icon: ShieldCheck, hint: 'Single sign-on and sessions', role: 'settings:manage' },
  { id: 'audit', label: 'Audit log', icon: ScrollText, hint: 'Who did what; SIEM streaming', role: 'audit:read' },
  { id: 'governance', label: 'Governance', icon: Landmark, hint: 'Allowed nodes, publish approval' },
  { id: 'source-control', label: 'Source control', icon: GitBranch, hint: 'Push and pull workflows with Git', role: 'settings:manage' },
  { id: 'environments', label: 'Environments', icon: Layers, hint: 'Promote between environments', role: 'settings:manage' },
  { id: 'external-secrets', label: 'External secrets', icon: Vault, hint: 'Vault, 1Password, cloud secret stores', role: 'settings:manage' },
  { id: 'workers', label: 'Workers', icon: Cpu, hint: 'Queue mode, workers and the leader' },
  { id: 'transports', label: 'Transports', icon: Network, hint: 'HTTP, gRPC and broker connections', role: 'settings:manage' },
];
type Section = string;

const BODIES: Record<string, () => React.ReactNode> = {
  general: () => <GeneralSettings />,
  variables: () => <VariablesSettings />,
  alerts: () => <AlertsSettings />,
  'ai-prices': () => (
    <div className="space-y-4">
      <AiPricesSettings />
      <AiCapsSettings />
    </div>
  ),
  mcp: () => <McpSettings />,
  users: () => <UsersSettings />,
  'api-keys': () => <ApiKeysSettings />,
  api: () => <ApiDocs />,
  security: () => <SecuritySettings />,
  audit: () => <AuditSettings />,
  governance: () => <GovernanceSettings />,
  'source-control': () => <SourceControlSettings />,
  environments: () => <EnvironmentsSettings />,
  'external-secrets': () => <ExternalSecretsSettings />,
  workers: () => <WorkersSettings />,
  transports: () => <TransportsSettings />,
};

/** /settings (#general, #variables, #alerts, #ai-prices, #mcp, #users, #api-keys, #api, #security, #audit, #governance, #source-control, #environments, #external-secrets, #workers, #transports): instance settings. */
export default function SettingsPage() {
  const viewer = useViewer();
  const sections = SECTIONS.filter((s) => !s.role || can(viewer, s.role));
  const [chosen, setSection] = useState<Section>('general');
  const section = sections.some((s) => s.id === chosen) ? chosen : 'general';
  // A phone shows the sections as a list first, and one section at a time (docs/mobile.md#settings-and-agents).
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    const fromHash = () => {
      const found = SECTIONS.find((s) => `#${s.id}` === window.location.hash)?.id;
      setSection(found ?? 'general');
      setOpened(Boolean(found));
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);

  const choose = (id: Section) => {
    setSection(id);
    setOpened(true);
    window.history.replaceState(null, '', `#${id}`);
  };
  const backToList = () => {
    setOpened(false);
    window.history.replaceState(null, '', window.location.pathname);
  };

  return (
    <>
      <PageHeader title="Settings" meta={<span>Instance-wide</span>} />
      <PageBody className="grid max-w-[1080px] grid-cols-1 gap-6 md:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className={cn('flex gap-1 overflow-x-auto md:flex-col max-md:flex-col max-md:gap-0 max-md:overflow-visible max-md:rounded-2xl max-md:border max-md:border-hair max-md:bg-sf', opened && 'max-md:hidden')}>
          {sections.map((item) => {
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
                  <span className="block truncate text-[11px] text-t3 max-md:text-[12.5px]">{item.hint}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-t3 md:hidden" aria-hidden />
              </button>
            );
          })}
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
