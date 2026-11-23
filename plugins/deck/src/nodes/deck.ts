import { NodeOperationError, type IExecuteContext, type INodeType, type NodeDescriptor } from '@landflow/sdk';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, sharedWatches, type Watches } from '../watches';
import { DeckError, dispatch } from '../deck-cli';

/**
 * dot-agent-deck: start a unit of work in the person's deck from a flow. Dispatch returns once the deck's daemon admits
 * the request; the unit's completion is POSTed to Report To (the run's resume URL), so a Wait "On Webhook Call" after this
 * node pauses the run without holding a worker. Delegate is not offered: the deck allows it to an orchestrator only.
 */
export class Deck implements INodeType {
  /** Tests give it their own table of watches. */
  constructor(private readonly table?: Watches) {}

  private get watchesOf(): () => Watches {
    return () => this.table ?? sharedWatches();
  }

  readonly description: NodeDescriptor = {
    name: 'deck',
    displayName: 'dot-agent-deck',
    description: 'Start a unit of work in your dot-agent-deck and report its completion to the run',
    version: 1,
    kind: 'action',
    categories: ['Developer'],
    icon: 'file:deck.svg',
    color: '#4f46e5',
    subtitle: '{{operation}}: {{name}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    outputSchema: {
      type: 'object',
      properties: {
        unit: { type: 'string', description: 'the unit\'s name, as the deck knows it' },
        admitted: { type: 'boolean', description: 'the deck daemon admitted the request (the unit may still fail to start; the deck shows it)' },
        message: { type: 'string', description: 'what the deck printed' },
        watching: { type: 'boolean', description: 'true when the plugin will POST the unit\'s completion to Report To' },
      },
    },
    properties: [
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        default: 'dispatch',
        options: [{ name: 'Dispatch', value: 'dispatch', description: 'Start a unit in a new git worktree, or in a directory you name', action: 'Dispatch a unit' }],
      },
      { name: 'name', displayName: 'Unit Name', type: 'string', default: '', required: true, placeholder: 'nightly-fix', description: '1-40 lowercase letters, digits and dashes. It names the unit\'s tab, worktree and branch, and must be unique while the unit runs' },
      { name: 'task', displayName: 'Task', type: 'string', default: '', required: true, typeOptions: { rows: 6 }, description: 'What the unit should do. Sent as is, up to 1 MiB' },
      { name: 'agent', displayName: 'Agent', type: 'string', default: '', placeholder: 'claude', description: 'The deck agent to run: claude, opencode, pi, codex or devin. Empty uses the pane\'s own' },
      { name: 'command', displayName: 'Command', type: 'string', default: '', description: 'The command the unit\'s agent starts with. Off unless LANDFLOW_DECK_ALLOW_COMMAND=1 is set where the plugin runs, because it runs as you' },
      { name: 'dir', displayName: 'Directory', type: 'string', default: '', placeholder: '/path/to/project', description: 'An existing absolute directory to start in instead of a new worktree' },
      {
        name: 'reportTo',
        displayName: 'Report To',
        type: 'string',
        default: '{{ $execution.resumeUrl }}',
        description: 'Where the unit\'s completion is POSTed as { unit, report, status }. Leave it, and put a Wait node after this one set to "On Webhook Call" with HTTP Method POST. Empty: nothing watches. Only this host\'s own addresses are accepted',
      },
      { name: 'timeoutMinutes', displayName: 'Watch For (minutes)', type: 'number', default: DEFAULT_TIMEOUT_MS / 60_000, description: `How long the plugin waits for the unit to report: up to ${MAX_TIMEOUT_MS / 60_000} (24 h). Set the Wait node's timeout the same. The unit keeps running afterwards` },
      { name: 'notice', displayName: 'Run the dot-agent-deck plugin inside a deck pane (pnpm plugin:deck). The deck refuses dispatch from anywhere else. The unit starts on that machine and runs as that user.', type: 'notice', default: '' },
    ],
  };

  async execute(ctx: IExecuteContext) {
    const items = ctx.getInputData();
    const out = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const name = String(ctx.getNodeParameter('name', i) ?? '').trim();
        const reportTo = String(ctx.getNodeParameter('reportTo', i, '') ?? '').trim();
        const minutes = Number(ctx.getNodeParameter('timeoutMinutes', i, DEFAULT_TIMEOUT_MS / 60_000));
        const watches = this.watchesOf();
        // Checked before the unit starts: a bad Report To must not leave a unit nobody can hear from.
        if (reportTo) watches.checkReportTo(reportTo);
        const result = await ctx.span('deck.dispatch', { 'landflow.execution.id': ctx.getExecutionId(), 'deck.unit.name': name }, () =>
          dispatch({
            name,
            task: String(ctx.getNodeParameter('task', i) ?? ''),
            agent: String(ctx.getNodeParameter('agent', i, '') ?? '').trim() || undefined,
            command: String(ctx.getNodeParameter('command', i, '') ?? '').trim() || undefined,
            dir: String(ctx.getNodeParameter('dir', i, '') ?? '').trim() || undefined,
          }),
        );
        if (reportTo) watches.add(name, reportTo, Number.isFinite(minutes) ? minutes * 60_000 : DEFAULT_TIMEOUT_MS);
        out.push({ json: { ...items[i].json, unit: name, admitted: result.admitted, message: result.message, watching: Boolean(reportTo) } });
      } catch (error) {
        if (error instanceof DeckError) throw new NodeOperationError(error.message, { itemIndex: i, ...(error.description && { description: error.description }) });
        throw error;
      }
    }
    return [out];
  }
}
