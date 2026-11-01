'use client';
/**
 * The "Agent session" panel of the execution view: what the agent of a Run an Agent node is doing, live while the
 * run goes on (polled from GET /api/agents/:id/sessions?executionId=) and read in full after it. The timeline is the
 * agents' own (TimelineView), so a remote A2A agent's steps show as they do on the agent's Sessions tab.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Bot, ChevronDown, ExternalLink, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { matchesNode, remoteRunOfProgress, type NodeProgress } from '@/lib/client/node-progress';
import type { AgentSession } from '@/lib/shared/agents';
import { TimelineView } from '../agents/timeline';
import { liveTeam } from '../editor/team-strip';

export interface AgentNodeRef {
  nodeId: string;
  name: string;
  agentId: string;
}

const POLL_MS = 2000;

export function AgentSessionPanel({
  executionId,
  nodes,
  running,
  selectedNodeId,
  live,
  progress = {},
}: {
  executionId: string;
  nodes: AgentNodeRef[];
  /** Ids of the nodes that are running now. */
  running: string[];
  selectedNodeId?: string;
  /** The execution is still running: keep polling. */
  live: boolean;
  /** Latest node.progress per running node: the steps of a flow tool (a sub-node) under its tool call. */
  progress?: Record<string, NodeProgress>;
}) {
  const [open, setOpen] = useState<boolean>();
  const [picked, setPicked] = useState<string>();
  const runningNode = nodes.find((n) => running.includes(n.nodeId));
  const node = nodes.find((n) => n.nodeId === picked) ?? runningNode ?? nodes.find((n) => n.nodeId === selectedNodeId) ?? nodes[0];
  // Open by itself while an agent works; a click on the header overrides that.
  const expanded = open ?? Boolean(runningNode);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [error, setError] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const nodeId = node?.nodeId;
  const agentId = node?.agentId;

  useEffect(() => {
    if (!nodeId || !agentId || !expanded) return;
    let stopped = false;
    const load = () =>
      api<{ sessions: AgentSession[] }>(`/api/agents/${encodeURIComponent(agentId)}/sessions?executionId=${encodeURIComponent(executionId)}&nodeId=${encodeURIComponent(nodeId)}`)
        .then((r) => {
          if (stopped) return;
          setSessions(r.sessions);
          setError(undefined);
          setLoaded(true);
        })
        .catch((e: Error) => !stopped && (setError(e.message), setLoaded(true)));
    setLoaded(false);
    void load();
    // Once more after the run ends (the final save), then no polling.
    const timer = live ? setInterval(load, POLL_MS) : undefined;
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [executionId, nodeId, agentId, expanded, live]);

  // Follow the newest entry while live, unless the person scrolled up.
  const entryCount = sessions.reduce((n, s) => n + s.timeline.length, 0);
  useEffect(() => {
    const el = bodyRef.current;
    if (el && live && stick.current) el.scrollTop = el.scrollHeight;
  }, [entryCount, live]);

  if (!node) return null;
  const working = Boolean(runningNode);
  // A team node's report names the member at work (lib/shared/team-progress.ts): the session is the lead's, the work is theirs.
  const member = live ? liveTeam(progress[node.nodeId]?.data as Record<string, unknown> | undefined)?.member : undefined;
  return (
    // Gives way before the canvas does: on a short screen the session shrinks to its header and scrolls.
    <div className="flex min-h-9 flex-col border-t border-hair bg-sf" data-testid="agent-session-panel">
      <div className="flex h-9 shrink-0 items-center gap-2 px-4">
        <button onClick={() => setOpen(!expanded)} aria-expanded={expanded} className="flex items-center gap-2 text-[13px] font-semibold text-t1">
          <ChevronDown className={cn('size-3.5 text-t3 transition-transform', !expanded && '-rotate-90')} />
          <Bot className="size-3.5 text-ac" />
          Agent session
          {working && <Loader2 className="size-3 animate-spin text-ac" />}
        </button>
        {nodes.length > 1 ? (
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
            {nodes.map((n) => (
              <button
                key={n.nodeId}
                onClick={() => {
                  setPicked(n.nodeId);
                  setOpen(true);
                }}
                className={cn('shrink-0 rounded-full border px-2 text-[12px]', n.nodeId === node.nodeId ? 'border-acbd bg-acdim text-ac' : 'border-hair text-t2 hover:text-t1')}
              >
                {n.name}
              </button>
            ))}
          </div>
        ) : (
          <span className="truncate text-[12px] text-t3">
            {node.name}
            {member && member.toLowerCase() !== node.name.toLowerCase() && <span className="font-medium text-t2"> · {member} working</span>}
          </span>
        )}
      </div>
      {expanded && (
        <div
          ref={bodyRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
          className="max-h-[320px] min-h-0 overflow-y-auto border-t border-hair px-4 py-3"
        >
          {error ? (
            <p className="text-[13px] text-rd">{error}</p>
          ) : !sessions.length ? (
            <p className="text-[13px] text-t3">{!loaded ? 'Loading…' : working || live ? 'Waiting for the agent to start…' : 'No session was saved for this node (it ran before sessions were linked to executions).'}</p>
          ) : (
            <div className="space-y-4">
              {sessions.map((session) => (
                <div key={session.id}>
                  <div className="mb-2 flex items-center gap-2 text-[12px] text-t3">
                    <span className="font-semibold text-t2">{session.agentName}</span>
                    <span>{session.status === 'running' ? 'running' : session.status === 'error' ? 'failed' : session.status === 'awaiting_approval' ? 'needs approval' : 'done'}</span>
                    <span>· {(session.usage.inputTokens + session.usage.outputTokens).toLocaleString()} tokens</span>
                    <Link href={`/agents/${session.agentId}?tab=sessions&session=${encodeURIComponent(session.id)}`} className="ml-auto flex items-center gap-1 text-ac hover:underline">
                      Open on the agent’s page <ExternalLink className="size-3" />
                    </Link>
                  </div>
                  <TimelineView
                    entries={session.timeline}
                    wide
                    liveSteps={(entry) => {
                      const event = Object.values(progress).find((p) => p.parentNodeId === node.nodeId && matchesNode(entry, p.nodeName));
                      return event ? remoteRunOfProgress(event) : undefined;
                    }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
