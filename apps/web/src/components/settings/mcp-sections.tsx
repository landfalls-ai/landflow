'use client';
/**
 * Settings → MCP as four collapsed sections (Access token, Connected clients, Tools, Gateway), each with one sentence
 * and a way to learn more, and above them, for owners and admins, the "Work from local tools" row: the switch that
 * forbids people's tools sending their work on their own (`brain.workAutoSend`, docs/connect-your-harness.md).
 */
import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronRight, KeyRound, Laptop, Network, Plug, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { API_KEY_SCOPES, type ApiKeyScope } from '@/lib/shared/auth';
import { TOOL_SCOPES } from '@/lib/shared/mcp';
import { Card } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/inputs';

const DOCS = 'https://github.com/landfalls-ai/landflow/blob/main/docs';

/** One collapsed section: a header that opens it, with the sentence and "Learn more" under the title. */
export function McpSection({ id, icon, title, sentence, learnMore, badge, forceOpen, children }: { id: string; icon: ReactNode; title: string; sentence: string; learnMore: string; badge?: ReactNode; forceOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(Boolean(forceOpen));
  // Once opened the children stay mounted (hidden only), so a token shown once survives a collapse.
  const [seen, setSeen] = useState(Boolean(forceOpen));
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  useEffect(() => {
    if (open) setSeen(true);
  }, [open]);
  return (
    <Card className="p-0">
      <div className="flex items-start gap-2 px-4 py-3 max-md:px-3">
        <button type="button" id={`${id}-button`} aria-expanded={open} aria-controls={`${id}-panel`} onClick={() => setOpen((o) => !o)} className="flex min-h-11 min-w-0 flex-1 items-start gap-2.5 text-left">
          <ChevronRight className={cn('mt-0.5 size-4 shrink-0 text-t3 transition-transform duration-[120ms] motion-reduce:transition-none', open && 'rotate-90')} aria-hidden />
          <span className="mt-0.5 shrink-0 text-t3">{icon}</span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-[13px] font-semibold text-t1">
              {title}
              {badge}
            </span>
            <span className="mt-0.5 block text-[12px] leading-relaxed text-t3">{sentence}</span>
          </span>
        </button>
        <a href={learnMore} target="_blank" rel="noreferrer noopener" className="mt-2.5 shrink-0 text-[12px] text-ac hover:underline max-md:py-3">
          Learn more
        </a>
      </div>
      <div id={`${id}-panel`} role="region" aria-labelledby={`${id}-button`} hidden={!open} className="space-y-4 border-t border-hair px-4 py-4 max-md:px-3">
        {(open || seen) && children}
      </div>
    </Card>
  );
}

/** The tools an API key reaches, each with the scope it needs (the map is `TOOL_SCOPES`; a session or MCP token sees all of them). */
export function ToolScopeList() {
  const byScope = API_KEY_SCOPES.map((scope) => ({ scope, tools: Object.entries(TOOL_SCOPES).filter(([, s]) => s === scope).map(([name]) => name) })).filter((g) => g.tools.length > 0);
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-t3">
        What the instance MCP server offers, and the scope an API key needs for each (<Link href="/connect" className="text-ac hover:underline">make a key</Link>). A session or an MCP token reaches every tool.
      </p>
      {byScope.map(({ scope, tools }) => (
        <div key={scope}>
          <div className="mb-1 flex items-center gap-2">
            <Badge tone="muted" className="font-mono">
              {scope satisfies ApiKeyScope}
            </Badge>
            <span className="text-[11px] text-t3">{tools.length} tools</span>
          </div>
          <ul className="flex flex-wrap gap-1.5">
            {tools.map((name) => (
              <li key={name} className="rounded-md border border-hair bg-wl px-2 py-1 font-mono text-[11px] text-t1">
                {name}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

type BrainSetting = 'allowed' | 'forbidden';

/** "Work from local tools" (owners and admins): Allow automatic sending on or off. */
export function WorkFromLocalTools() {
  const [setting, setSetting] = useState<BrainSetting>();
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api<{ settings: { brain?: { workAutoSend?: BrainSetting } } }>('/api/settings')
      .then((r) => setSetting(r.settings.brain?.workAutoSend ?? 'allowed'))
      .catch(() => setLoadError(true));
  }, []);
  const change = async (allowed: boolean) => {
    const workAutoSend: BrainSetting = allowed ? 'allowed' : 'forbidden';
    setSaving(true);
    try {
      await api('/api/settings', { method: 'PATCH', json: { brain: { workAutoSend } } });
      setSetting(workAutoSend);
      toast.success(allowed ? 'Tools may send work on their own' : 'Tools hold work for a person to send');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card className="flex items-center justify-between gap-4 px-4 py-3 max-md:px-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <Laptop className="mt-0.5 size-4 shrink-0 text-t3" strokeWidth={1.8} />
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-t1">Work from local tools</div>
          <p className="text-[12px] leading-relaxed text-t3">Allow automatic sending: when it is off, people’s coding tools hold their work until the person sends it themselves.</p>
        </div>
      </div>
      {loadError && <span className="text-[12px] text-danger">Couldn’t load this setting.</span>}
      {setting && <Switch checked={setting === 'allowed'} onChange={(v) => void change(v)} disabled={saving} label="Allow automatic sending" />}
    </Card>
  );
}

export function McpSections({ canManage, gatewayMode, pendingApprovals = 0, access, clients, tools, gateway }: { canManage: boolean; gatewayMode: string; pendingApprovals?: number; access: ReactNode; clients: ReactNode; tools: ReactNode; gateway: ReactNode }) {
  const instanceTools = Object.keys(TOOL_SCOPES).length;
  return (
    <div className="space-y-3">
      {canManage && <WorkFromLocalTools />}
      <McpSection id="mcp-access" icon={<KeyRound className="size-4" strokeWidth={1.8} />} title="Access token" sentence="The tokens agents send to prove who they are." learnMore={`${DOCS}/features/ai.md`}>
        {access}
      </McpSection>
      <McpSection id="mcp-clients" icon={<Plug className="size-4" strokeWidth={1.8} />} title="Connected clients" sentence="Copy the setup for an agent; your own tools are set up on Connect your harness." learnMore={`${DOCS}/connect-your-harness.md`}>
        <p className="text-[12px] text-t3">
          For Claude Code, Cursor, Codex CLI, Gemini CLI or VS Code with a brain key, use <Link href="/connect" className="text-ac hover:underline">Connect your harness</Link>.
        </p>
        {clients}
      </McpSection>
      <McpSection id="mcp-tools" icon={<Wrench className="size-4" strokeWidth={1.8} />} title="Tools" sentence="What agents can call, the scope each tool needs, and calls waiting for your approval." learnMore={`${DOCS}/features/ai.md`} forceOpen={pendingApprovals > 0} badge={
          <>
            <Badge tone="muted">{instanceTools} instance tools</Badge>
            {pendingApprovals > 0 && <Badge tone="warning">{pendingApprovals} waiting for approval</Badge>}
          </>
        }>
        <ToolScopeList />
        {tools}
      </McpSection>
      <McpSection id="mcp-gateway" icon={<Network className="size-4" strokeWidth={1.8} />} title="Gateway" sentence="The bundled gateway puts every plugin behind one URL." learnMore={`${DOCS}/transports.md`} badge={<Badge tone={gatewayMode === 'off' ? 'muted' : 'accent'} className="font-mono">{gatewayMode}</Badge>}>
        {gateway}
      </McpSection>
    </div>
  );
}
