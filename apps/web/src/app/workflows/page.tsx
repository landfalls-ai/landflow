'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { NodeTypeInfo, WorkflowSummary } from '@/lib/shared/types';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { NodeIcon } from '@/components/ui/icon';
import { nodeColor, tint } from '@/lib/client/node-style';

const MAX_ICONS = 6;

export default function WorkflowsPage() {
  const router = useRouter();
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>();
  const [types, setTypes] = useState<Record<string, NodeTypeInfo>>({});
  const [creating, setCreating] = useState(false);

  const load = () => api<{ workflows: WorkflowSummary[] }>('/api/workflows').then((r) => setWorkflows(r.workflows));
  useEffect(() => {
    void load();
    api<{ nodeTypes: NodeTypeInfo[] }>('/api/node-types').then((r) => setTypes(Object.fromEntries(r.nodeTypes.map((t) => [t.type, t]))));
  }, []);

  const create = async () => {
    setCreating(true);
    try {
      const { workflow } = await api<{ workflow: { id: string } }>('/api/workflows', { method: 'POST', json: { name: 'Untitled workflow', nodes: [], connections: [] } });
      router.push(`/workflows/${workflow.id}`);
    } catch (e) {
      toast.error((e as Error).message);
      setCreating(false);
    }
  };

  const remove = async (id: string, name: string) => {
    await api(`/api/workflows/${id}`, { method: 'DELETE' });
    toast(`Deleted “${name}”`);
    void load();
  };

  return (
    <>
      <PageHeader
        title="Workflows"
        meta={workflows && <span>{workflows.length}</span>}
        actions={
          <Button variant="primary" size="sm" onClick={() => void create()} loading={creating}>
            {!creating && <Plus className="size-3.5" strokeWidth={2} />} New workflow
          </Button>
        }
      />
      <PageBody>
        <div className="flex flex-col gap-2">
          {workflows?.map((workflow) => (
            <div key={workflow.id} className="group flex items-center rounded-2xl border border-hair bg-sf transition-colors duration-[120ms] hover:border-bd">
              <Link href={`/workflows/${workflow.id}`} className="flex min-w-0 flex-1 items-center gap-4 py-3 pl-4">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-t1">{workflow.name}</div>
                  <div className="mt-1.5 flex min-w-0 items-center gap-2.5">
                    {workflow.nodeTypes.length > 0 && (
                      <div className="flex shrink-0 items-center gap-1">
                        {workflow.nodeTypes.slice(0, MAX_ICONS).map((type) => {
                          const info = types[type];
                          const color = nodeColor(info);
                          return (
                            <span
                              key={type}
                              title={info?.descriptor.displayName ?? type}
                              className="grid size-6 place-items-center rounded-lg border border-hair transition-transform duration-150 group-hover:scale-105"
                              style={{ background: tint(color, 12) }}
                            >
                              <NodeIcon icon={info?.descriptor.icon} size={13} strokeWidth={1.9} style={{ color }} />
                            </span>
                          );
                        })}
                        {workflow.nodeTypes.length > MAX_ICONS && <span className="pl-0.5 text-[12px] text-t3">+{workflow.nodeTypes.length - MAX_ICONS}</span>}
                      </div>
                    )}
                    <span className="truncate text-[12px] text-t3">{workflow.description || 'No description'}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {workflow.tags.map((tag) => (
                    <Badge key={tag} tone="neutral" className="hidden md:inline-flex">
                      {tag}
                    </Badge>
                  ))}
                  {workflow.active && <Badge tone="success">Active</Badge>}
                  <span className="hidden w-16 text-right text-[12px] text-t3 sm:inline">
                    {workflow.nodeCount} {workflow.nodeCount === 1 ? 'node' : 'nodes'}
                  </span>
                  <span className="w-16 text-right text-[12px] tabular-nums text-t2">{timeAgo(workflow.updatedAt)}</span>
                </div>
              </Link>
              <div className="pl-2 pr-2.5">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title="Delete"
                  aria-label={`Delete ${workflow.name}`}
                  onClick={() => void remove(workflow.id, workflow.name)}
                  className="text-t3 opacity-0 hover:bg-rddim hover:text-rd focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Trash2 className="size-3.5" strokeWidth={1.7} />
                </Button>
              </div>
            </div>
          ))}
        </div>
        {workflows && workflows.length === 0 && (
          <Card>
            <EmptyState
              title="No workflows yet"
              hint="Chain built-in nodes with plugins written in any language. Every node, local or remote, implements the same interface."
              action={
                <Button variant="primary" size="sm" onClick={() => void create()} loading={creating}>
                  New workflow
                </Button>
              }
            />
          </Card>
        )}
      </PageBody>
    </>
  );
}
