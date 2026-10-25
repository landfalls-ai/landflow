'use client';
/** Agents (Preview): standalone assistants that use your tools, workflows and other agents. */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bot, Plus, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { AgentSummary } from '@/lib/shared/agents';
import { parseAgentFile } from '@/components/agents/util';
import { useAgentData } from '@/components/agents/use-agent-data';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AppIcon } from '@/components/ui/icon';

export default function AgentsPage() {
  const router = useRouter();
  const agents = useAgentData((s) => s.agents);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void useAgentData.getState().loadAgents().finally(() => setLoaded(true));
  }, []);

  const create = async () => {
    setCreating(true);
    try {
      const { agent } = await api<{ agent: { id: string } }>('/api/agents', { method: 'POST', json: {} });
      router.push(`/agents/${agent.id}`);
    } catch (e) {
      toast.error((e as Error).message);
      setCreating(false);
    }
  };

  const importFile = async (file?: File) => {
    if (!file) return;
    try {
      const config = parseAgentFile(await file.text());
      const { agent } = await api<{ agent: { id: string; name: string } }>('/api/agents/import', { method: 'POST', json: { config } });
      toast.success(`Imported “${agent.name}”`);
      router.push(`/agents/${agent.id}`);
    } catch (e) {
      toast.error(`Could not import ${file.name}: ${(e as Error).message}`);
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const list = loaded ? (agents ?? []) : undefined;
  const sorted = list && [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const actions = (
    <>
      <Button size="sm" onClick={() => fileInput.current?.click()}>
        <Upload className="size-3.5" /> <span className="hidden sm:inline">Import JSON</span>
      </Button>
      <Button variant="primary" size="sm" onClick={() => void create()} loading={creating}>
        {!creating && <Plus className="size-3.5" strokeWidth={2} />} Create agent
      </Button>
    </>
  );

  return (
    <>
      <PageHeader
        title="Agents"
        meta={
          <>
            <span className="rounded-full border border-acbd bg-acdim px-1.5 text-[10px] font-semibold leading-4 text-ac">Preview</span>
            {sorted && sorted.length > 0 && <span>{sorted.length}</span>}
          </>
        }
        actions={actions}
      />
      <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={(e) => void importFile(e.target.files?.[0])} />
      <PageBody>
        {!sorted && (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[68px] rounded-2xl border border-hair bg-sf animate-pulse-soft" style={{ animationDelay: `${i * 120}ms` }} />
            ))}
          </div>
        )}
        {sorted && sorted.length === 0 && (
          <div className="mx-auto mt-10 flex max-w-[460px] animate-fade-up flex-col items-center text-center">
            <span className="grid size-16 place-items-center rounded-[22px] border border-acbd bg-acdim text-ac">
              <Bot className="size-8" strokeWidth={1.5} />
            </span>
            <h2 className="mt-5 text-[20px] font-semibold tracking-[-0.01em] text-t1">Create your first agent</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-t2">Agents automate tasks and answer questions using your connected tools and data.</p>
            <div className="mt-5 flex gap-2">
              <Button variant="primary" onClick={() => void create()} loading={creating}>
                {!creating && <Plus className="size-3.5" strokeWidth={2} />} Create agent
              </Button>
              <Button onClick={() => fileInput.current?.click()}>
                <Upload className="size-3.5" /> Import JSON
              </Button>
            </div>
          </div>
        )}
        {sorted && sorted.length > 0 && (
          <div className="flex flex-col gap-2">
            {sorted.map((agent, i) => (
              <AgentRow key={agent.id} agent={agent} index={i} />
            ))}
          </div>
        )}
      </PageBody>
    </>
  );
}

function AgentRow({ agent, index }: { agent: AgentSummary; index: number }) {
  return (
    <Link
      href={`/agents/${agent.id}`}
      className="group flex animate-fade-up items-center gap-4 rounded-2xl border border-hair bg-sf px-4 py-3 transition-colors duration-[120ms] hover:border-bd"
      style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
    >
      <AppIcon icon={agent.icon} color={agent.color} size={40} className="transition-transform duration-150 group-hover:scale-105" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-t1">{agent.name}</span>
          {agent.publishedVersion ? <Badge tone="success">Published v{agent.publishedVersion}</Badge> : <Badge tone="muted">Draft</Badge>}
          {agent.publishedVersion && agent.draftChanged && (
            <Badge tone="warning" className="hidden sm:inline-flex">
              Changes not published
            </Badge>
          )}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2 text-[12px] text-t3">
          <span className="truncate">{agent.description || 'No description'}</span>
        </div>
      </div>
      <div className="hidden shrink-0 flex-col items-end gap-0.5 text-[12px] text-t3 md:flex">
        <span className="max-w-[180px] truncate font-mono text-[11px] text-t2">{agent.model || 'No model'}</span>
        <span>
          {agent.tools} {agent.tools === 1 ? 'tool' : 'tools'} · {agent.skills} {agent.skills === 1 ? 'skill' : 'skills'}
        </span>
      </div>
      <div className="hidden w-20 shrink-0 text-right text-[12px] text-t3 sm:block">
        {agent.sessions} {agent.sessions === 1 ? 'session' : 'sessions'}
      </div>
      <span className="w-16 shrink-0 text-right text-[12px] tabular-nums text-t2">{timeAgo(agent.updatedAt)}</span>
    </Link>
  );
}
