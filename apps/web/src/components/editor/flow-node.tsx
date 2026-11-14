'use client';
import { memo, useEffect } from 'react';
import { NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import { useShallow } from 'zustand/react/shallow';
import { CircleDot, Copy, Hand, Loader2, MoreHorizontal, Play, Power, Settings2, SkipForward, Trash2, UsersRound, Wrench, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MenuItem, Popover } from '../ui/popover';
import type { ExecutionEvent } from '@/lib/shared/types';
import { progressDetail, progressLine } from '@/lib/client/node-progress';
import { decideToolApprovals } from '@/lib/client/run-trace';
import { useNodeFace, useShownParameters } from '../agents/faces';
import { isCompact, NodeTile, ranFor } from '../canvas/node-tile';
import { useAssistant } from './assistant';
import { openNeedOf } from './timeline';
import { activityOfRuns } from '@/lib/shared/team-progress';
import { teamQuestionOf, useTeamTile } from './team-live';
import { liveTeam, TeamStrip } from './team-strip';
import { canTurnNodeIntoTeam, turnIntoTeam } from './turn-into-team';
import { useEditor, type FlowNode } from './store';

/** What a team node's slots feed: the lead, not every member. */
const LEAD_SLOTS = { ai_languageModel: "Lead's model", ai_memory: "Lead's memory", ai_tool: "Lead's tools" } as const;

/** One thing a node can do, shared by its hover toolbar and the right-click menu. */
export interface NodeAction {
  id: 'run' | 'disable' | 'delete' | 'open' | 'runFrom' | 'breakpoint' | 'team' | 'duplicate';
  label: string;
  icon: typeof Play;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
}

/**
 * A node's actions: Run, Disable and Delete are buttons on the hover toolbar (and the first items of the right-click
 * menu); ⋯ (and the rest of the menu) holds the others. A compact node (a tool, a model) has no Run.
 */
export function nodeActions(id: string): { main: NodeAction[]; more: NodeAction[] } | undefined {
  const state = useEditor.getState();
  const node = state.nodes.find((n) => n.id === id);
  if (!node) return undefined;
  const wf = node.data.wf;
  const descriptor = state.nodeTypes[wf.type]?.descriptor;
  const asTool = state.edges.some((e) => e.source === id && e.data?.connectionType === 'ai_tool');
  const compact = isCompact(descriptor, wf.parameters, asTool);
  const breakpoint = state.breakpoints.includes(id);
  const canTeam =
    wf.type === 'core.messageAgent' &&
    state.edges.some((e) => e.target === id && e.data?.connectionType === 'ai_tool') &&
    canTurnNodeIntoTeam(id);
  const run = (scope: 'from' | 'only') => () => !useEditor.getState().running && void state.run?.({ kind: 'node', nodeId: id, scope });
  const main: NodeAction[] = [
    ...(compact ? [] : [{ id: 'run' as const, label: 'Run this node', icon: Play, hint: 'and what it needs', disabled: state.running, run: run('only') }]),
    { id: 'disable', label: wf.disabled ? 'Enable' : 'Disable', icon: Power, run: () => state.updateNode(id, { disabled: !wf.disabled }) },
    { id: 'delete', label: 'Delete', icon: Trash2, danger: true, run: () => state.removeNodes([id]) },
  ];
  const more: NodeAction[] = [
    { id: 'open', label: 'Open', icon: Settings2, hint: 'double-click', run: () => state.openNode(id) },
    ...(compact
      ? []
      : [
          { id: 'runFrom' as const, label: 'Run from this node', icon: SkipForward, disabled: state.running, run: run('from') },
          { id: 'breakpoint' as const, label: breakpoint ? 'Remove breakpoint' : 'Add breakpoint', icon: CircleDot, hint: 'F9', run: () => state.toggleBreakpoint(id) },
        ]),
    ...(canTeam ? [{ id: 'team' as const, label: 'Turn into a team', icon: UsersRound, run: () => void turnIntoTeam(id) }] : []),
    { id: 'duplicate', label: 'Duplicate', icon: Copy, hint: '⌘D', run: () => state.duplicateNode(id) },
  ];
  return { main, more };
}

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
  // What the session fixed here: a bubble until dismissed or a minute passes.
  const fixNote = useAssistant((s) => s.fixNotes[id]);
  const needsYou = useAssistant((s) => openNeedOf(s.items)?.node === wf.name);
  const designing = useAssistant((s) => s.agents.some((a) => a.nodeId === id && a.state === 'designing'));
  // What it reports while it runs: a team's working member, a remote agent's step.
  const progress = useEditor((s) => s.progress[id]);
  const runs = useEditor((s) => s.runs[id]);
  const asTool = useEditor((s) => s.edges.some((e) => e.source === id && e.data?.connectionType === 'ai_tool'));
  const connectedOutputs = useEditor(
    useShallow((s) => s.edges.filter((e) => e.source === id && e.data?.connectionType === 'main').map((e) => e.sourceHandle ?? 'main:0')),
  );
  const subConnections = useEditor(useShallow((s) => s.edges.filter((e) => e.target === id && e.data?.connectionType !== 'main').map((e) => e.targetHandle)));
  const { openPalette, toggleBreakpoint } = useEditor.getState();

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
  const compact = isCompact(info?.descriptor, wf.parameters, asTool);
  // Only a selected node shows its toolbar; its actions are read when it renders (they follow disabled, breakpoint, running).
  const actions = selected ? nodeActions(id) : undefined;

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
      slotNames={wf.type === 'core.runTeam' ? LEAD_SLOTS : undefined}
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
      {/* Spotlight's one chip on this node: fixing, designing its agent, needs you, or what the last fix did. */}
      {(fixing || designing || needsYou || fixNote) && (
        <NodeToolbar isVisible position={Position.Top} offset={(compact ? 12 : 14) + (selected || progress || teamId ? 36 : 0)}>
          {fixing ? (
            <SpotlightChip tone="busy" text="Fixing…" />
          ) : designing ? (
            <SpotlightChip tone="busy" text="Designing its agent…" />
          ) : needsYou ? (
            <SpotlightChip tone="needs" text="Needs you" />
          ) : (
            fixNote && <FixNote nodeId={id} text={fixNote.text} at={fixNote.at} />
          )}
        </NodeToolbar>
      )}
      <NodeToolbar isVisible={selected} position={Position.Top} offset={compact ? 12 : 14}>
        <div className="flex animate-in items-center gap-0.5 rounded-full border border-hair bg-sf p-0.5 shadow-pop">
          {actions?.main.map((a) => (
            <ToolbarButton key={a.id} title={a.label} danger={a.danger} onClick={() => !a.disabled && a.run()}>
              <a.icon className="size-3.5" />
            </ToolbarButton>
          ))}
          {actions && (
            <Popover title="Node actions" label="More node actions" trigger={({ toggle }) => (
              <ToolbarButton title="More" onClick={toggle}>
                <MoreHorizontal className="size-3.5" />
              </ToolbarButton>
            )}>
              {(close) =>
                actions.more.map((a) => (
                  <MenuItem
                    key={a.id}
                    disabled={a.disabled}
                    hint={a.hint}
                    onClick={() => {
                      close();
                      a.run();
                    }}
                  >
                    <a.icon /> {a.label}
                  </MenuItem>
                ))
              }
            </Popover>
          )}
        </div>
      </NodeToolbar>
    </NodeTile>
  );
});

/** Spotlight's state on a node, in the words its panel uses: violet while it works, amber when the person is needed. */
function SpotlightChip({ tone, text }: { tone: 'busy' | 'needs'; text: string }) {
  return (
    <span
      role="status"
      className={cn(
        'flex animate-pop items-center gap-1 rounded-full border bg-sf px-2 py-0.5 text-[11px] font-semibold shadow-pop',
        tone === 'busy' ? 'border-acbd text-viz-7' : 'border-warnbd text-warn',
      )}
    >
      {tone === 'busy' ? <Loader2 className="size-3 animate-spin" /> : <Hand className="size-3" />} {text}
    </span>
  );
}

/** How long a fix's bubble stays on its node unless dismissed. */
const FIX_NOTE_MS = 60_000;

/** What Spotlight's test-and-fix session changed on this node, with × to dismiss it. */
function FixNote({ nodeId, text, at }: { nodeId: string; text: string; at: number }) {
  useEffect(() => {
    const timer = setTimeout(() => useAssistant.getState().dismissFix(nodeId), Math.max(0, at + FIX_NOTE_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [nodeId, at]);
  return (
    <div role="status" className="nodrag flex w-max max-w-[min(240px,70vw)] animate-pop items-start gap-1.5 rounded-xl border border-acbd bg-sf py-1 pl-2 pr-1 text-[11.5px] leading-snug text-t1 shadow-pop">
      <Wrench className="mt-px size-3 shrink-0 text-viz-7" />
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <span className="font-semibold text-viz-7">Fixed · </span>
        {text}
      </span>
      <button type="button" aria-label="Dismiss" title="Dismiss" onClick={() => useAssistant.getState().dismissFix(nodeId)} className="-my-1 grid size-7 shrink-0 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1 max-md:size-9">
        <X className="size-3.5" />
      </button>
    </div>
  );
}
