'use client';
import { memo } from 'react';
import { NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import { useShallow } from 'zustand/react/shallow';
import { CircleDot, Copy, Loader2, Play, Power, Settings2, SkipForward, Trash2, UsersRound } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ExecutionEvent } from '@/lib/shared/types';
import { progressDetail, progressLine } from '@/lib/client/node-progress';
import { decideToolApprovals } from '@/lib/client/run-trace';
import { useNodeFace, useShownParameters } from '../agents/faces';
import { isCompact, NodeTile, ranFor } from '../canvas/node-tile';
import { useAssistant } from './assistant';
import { activityOfRuns } from '@/lib/shared/team-progress';
import { teamQuestionOf, useTeamTile } from './team-live';
import { liveTeam, TeamStrip } from './team-strip';
import { canTurnNodeIntoTeam, turnIntoTeam } from './turn-into-team';
import { useEditor, type FlowNode } from './store';
import { useNewLook } from '../shell/look-toggle';

/** What a team node's slots feed: the lead, not every member (the new look). */
const LEAD_SLOTS = { ai_languageModel: "Lead's model", ai_memory: "Lead's memory", ai_tool: "Lead's tools" } as const;

function ToolbarButton({
  onClick,
  title,
  children,
  danger,
  active,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  danger?: boolean;
  active?: boolean;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'grid size-7 place-items-center rounded-full text-t2 transition-colors hover:bg-acdim hover:text-t1',
        danger && 'hover:bg-rddim hover:text-rd',
        active && 'text-rd',
      )}
    >
      {children}
    </button>
  );
}

export const FlowNodeView = memo(function FlowNodeView({ id, data, selected }: NodeProps<FlowNode>) {
  const { wf } = data;
  const info = useEditor((s) => s.nodeTypes[wf.type]);
  const status = useEditor((s) => s.statuses[id]);
  const breakpoint = useEditor((s) => s.breakpoints.includes(id));
  const pinned = useEditor((s) => Boolean(s.pinData[id]));
  const running = useEditor((s) => s.running);
  const fresh = useEditor((s) => s.lastAddedId === id);
  // Spotlight's test-and-fix session is asking for a fix to this node.
  const fixing = useAssistant((s) => s.fixing === id);
  // What it reports while it runs: a team's working member, a remote agent's step.
  const progress = useEditor((s) => s.progress[id]);
  const runs = useEditor((s) => s.runs[id]);
  const asTool = useEditor((s) => s.edges.some((e) => e.source === id && e.data?.connectionType === 'ai_tool'));
  const connectedOutputs = useEditor(
    useShallow((s) => s.edges.filter((e) => e.source === id && e.data?.connectionType === 'main').map((e) => e.sourceHandle ?? 'main:0')),
  );
  const subConnections = useEditor(useShallow((s) => s.edges.filter((e) => e.target === id && e.data?.connectionType !== 'main').map((e) => e.targetHandle)));
  // A Run an Agent node with agents hanging under it as tools can become a team.
  const canTeam = useEditor((s) => selected && s.nodeTypes[wf.type] !== undefined && wf.type === 'core.messageAgent' && s.edges.some((e) => e.target === id && e.data?.connectionType === 'ai_tool') && canTurnNodeIntoTeam(id));
  const { openNode, openPalette, removeNodes, duplicateNode, updateNode, toggleBreakpoint } = useEditor.getState();

  const face = useNodeFace(wf.type, wf.parameters);
  const shown = useShownParameters(wf.type, wf.parameters);
  // A team node becomes the member at work while it runs, and keeps a summary of what it did after (team-live.tsx).
  const teamId = wf.type === 'core.runTeam' && typeof wf.parameters.teamId === 'string' && wf.parameters.teamId ? wf.parameters.teamId : undefined;
  const live = teamId ? liveTeam(progress?.data) : undefined;
  // From the editor the Run Trace opens in a new tab, so the flow stays open.
  const executionId = useEditor((s) => (teamId ? s.executionId : undefined));
  const wait = useEditor((s) => (teamId && !s.running && s.wait?.nodeId === id ? s.wait : undefined));
  const asked = teamQuestionOf(wait, id);
  // A tool a member waits to use: Approve / Deny on the node resume the run, and the canvas follows it like a chat run.
  const decideInEditor = async (approved: boolean, edit?: { input?: Record<string, unknown>; callId?: string }) => {
    if (!executionId) return;
    let resumed = false;
    try {
      await decideToolApprovals(executionId, approved, (event, data) => {
        if (event === 'decision' && (data as { status?: string }).status === 'resumed' && !resumed) {
          resumed = true;
          useEditor.setState({ running: true, runStatus: 'running', executionId });
        }
        if (event === 'execution' && (data as ExecutionEvent).type !== 'node.chunk') useEditor.getState().applyEvent(data as ExecutionEvent);
      }, { ...(edit?.input && { input: edit.input }), ...(edit?.callId && { callId: edit.callId }) });
    } finally {
      if (resumed) useEditor.getState().finishRun();
    }
  };
  const team = useTeamTile(teamId, live, teamId && !live && !running ? activityOfRuns(runs) : undefined, { ...(executionId && { executionId }), ...(asked && { waiting: asked }), ...(asked?.approval && { onDecide: decideInEditor }), newTab: true, idleRoster: true });
  const newLook = useNewLook();
  const compact = isCompact(info?.descriptor, wf.parameters, asTool);
  const runNode = (scope: 'from' | 'only') => useEditor.getState().run?.({ kind: 'node', nodeId: id, scope });

  return (
    <NodeTile
      name={wf.name}
      info={info}
      parameters={shown}
      status={status}
      disabled={wf.disabled}
      selected={selected}
      breakpoint={breakpoint}
      pinned={pinned}
      asTool={asTool}
      connectedOutputs={connectedOutputs}
      subConnections={subConnections}
      onAddFromOutput={(handle) => openPalette({ from: { nodeId: id, handleId: handle, handleType: 'source' } })}
      onAddSubnode={(handle, type) => openPalette({ connectionType: type, from: { nodeId: id, handleId: handle, handleType: 'target' } })}
      onToggleBreakpoint={() => toggleBreakpoint(id)}
      fresh={fresh}
      face={face}
      live={team.tile}
      slotNames={newLook && wf.type === 'core.runTeam' ? LEAD_SLOTS : undefined}
    >
      {teamId && !team.roster ? (
        // Above the duration a finished node shows over its corner, and above the Waiting or Paused pill over its top.
        <NodeToolbar isVisible={!selected && !fixing} position={Position.Top} offset={(compact ? 12 : 14) + (ranFor(status) || status?.state === 'waiting' || status?.state === 'paused' ? 16 : 0)}>
          <TeamStrip teamId={teamId} live={live} moments={team.moments} />
        </NodeToolbar>
      ) : (
        !teamId &&
        progress && (
          <NodeToolbar isVisible={!selected && !fixing} position={Position.Top} offset={compact ? 12 : 14}>
            <span
              title={progressDetail(progress) ?? progressLine(progress)}
              className="block max-w-[220px] animate-fade-up truncate rounded-full border border-hair bg-sf px-2 py-px text-[11px] leading-4 text-t2 shadow-sm"
            >
              {progressLine(progress)}
            </span>
          </NodeToolbar>
        )
      )}
      <NodeToolbar isVisible={fixing && !selected} position={Position.Top} offset={compact ? 12 : 14}>
        <span className="flex animate-pop items-center gap-1 rounded-full border border-acbd bg-sf px-2 py-0.5 text-[11px] font-semibold text-viz-7 shadow-pop">
          <Loader2 className="size-3 animate-spin" /> Spotlight is fixing this
        </span>
      </NodeToolbar>
      <NodeToolbar isVisible={selected} position={Position.Top} offset={compact ? 12 : 14}>
        <div className="flex animate-in items-center gap-0.5 rounded-full border border-hair bg-sf p-0.5 shadow-pop">
          <ToolbarButton title="Open (double-click)" onClick={() => openNode(id)}>
            <Settings2 className="size-3.5" />
          </ToolbarButton>
          {!compact && (
            <>
              <ToolbarButton title="Run this node (and what it needs)" onClick={() => !running && runNode('only')}>
                <Play className="size-3.5" />
              </ToolbarButton>
              <ToolbarButton title="Run from this node" onClick={() => !running && runNode('from')}>
                <SkipForward className="size-3.5" />
              </ToolbarButton>
              <ToolbarButton title={breakpoint ? 'Remove breakpoint (F9)' : 'Add breakpoint (F9)'} active={breakpoint} onClick={() => toggleBreakpoint(id)}>
                <CircleDot className="size-3.5" />
              </ToolbarButton>
            </>
          )}
          <span className="mx-0.5 h-4 w-px bg-hair" />
          <ToolbarButton title={wf.disabled ? 'Enable' : 'Disable'} onClick={() => updateNode(id, { disabled: !wf.disabled })}>
            <Power className="size-3.5" />
          </ToolbarButton>
          {canTeam && (
            <ToolbarButton title="Turn into a team" onClick={() => void turnIntoTeam(id)}>
              <UsersRound className="size-3.5" />
            </ToolbarButton>
          )}
          <ToolbarButton title="Duplicate (⌘D)" onClick={() => duplicateNode(id)}>
            <Copy className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton title="Delete" danger onClick={() => removeNodes([id])}>
            <Trash2 className="size-3.5" />
          </ToolbarButton>
        </div>
      </NodeToolbar>
    </NodeTile>
  );
});
