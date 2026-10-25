'use client';
import { useEffect, useState } from 'react';
import { Braces, Plug, SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { GeneralSettings } from '@/components/settings/general-settings';
import { McpSettings } from '@/components/settings/mcp-settings';
import { VariablesSettings } from '@/components/settings/variables-settings';

const SECTIONS = [
  { id: 'general', label: 'General', icon: SlidersHorizontal, hint: 'Time zone and execution retention' },
  { id: 'variables', label: 'Variables', icon: Braces, hint: '$vars for expressions' },
  { id: 'mcp', label: 'MCP', icon: Plug, hint: 'Let coding agents build workflows' },
] as const;
type Section = (typeof SECTIONS)[number]['id'];

/** /settings (#general, #variables, #mcp): instance settings. */
export default function SettingsPage() {
  const [section, setSection] = useState<Section>('general');

  useEffect(() => {
    const fromHash = () => setSection(SECTIONS.find((s) => `#${s.id}` === window.location.hash)?.id ?? 'general');
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);

  const choose = (id: Section) => {
    setSection(id);
    window.history.replaceState(null, '', `#${id}`);
  };

  return (
    <>
      <PageHeader title="Settings" meta={<span>Instance-wide</span>} />
      <PageBody className="grid max-w-[1080px] grid-cols-1 gap-6 md:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="flex gap-1 md:flex-col">
          {SECTIONS.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <button
                key={item.id}
                onClick={() => choose(item.id)}
                aria-current={active ? 'page' : undefined}
                className={cn('flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-[120ms]', active ? 'bg-acdim' : 'hover:bg-acdim')}
              >
                <Icon className={cn('mt-0.5 size-4 shrink-0', active ? 'text-t1' : 'text-t3')} strokeWidth={1.8} />
                <span className="min-w-0">
                  <span className={cn('block text-[13px]', active ? 'font-semibold text-t1' : 'text-t2')}>{item.label}</span>
                  <span className="hidden truncate text-[11px] text-t3 md:block">{item.hint}</span>
                </span>
              </button>
            );
          })}
        </nav>
        <section key={section} className="min-w-0 animate-fade-up">
          <h2 className="mb-3 text-[15px] font-semibold text-t1">{SECTIONS.find((s) => s.id === section)?.label}</h2>
          {section === 'general' ? <GeneralSettings /> : section === 'mcp' ? <McpSettings /> : <VariablesSettings />}
        </section>
      </PageBody>
    </>
  );
}
