/**
 * The nightly SDLC velocity nodes (docs/second-brain.md#nightly-sdlc-velocity): Velocity Signals reads the company's
 * `work.*` events (only the ones a system reader may see: shared with the organization, or the platform's own; never
 * private ones) and raises one item per signal above its threshold; Propose Flows turns each into one flow idea, with a
 * build prompt Spotlight can build from, written by the brain's model or, with the model off, by a rule per signal type.
 * Signals are about the process, never about a person.
 */
import { createHash } from 'node:crypto';
import { defineNode, NodeOperationError, type JsonObject, type NodeItem } from '@landflow/sdk';
import { deterministicIdea, flaggedSignals, ideaFromModel, ideaPrompt, signalEventOf, TOIL_USAGE_KINDS, velocitySignals, type FlowIdea, type Signal, type SignalType } from '../brain/velocity';
import { listUsageEvents } from '../usage/query';

const main = [{ type: 'main' as const }];
const DAY_MS = 86_400_000;
/** The kinds the signals read: pull requests, reviews, CI, work sessions, and the usage kinds that show repeated asks. */
const READ_KINDS = ['work.pr_opened', 'work.pr_merged', 'work.pr_closed', 'work.pr_reviewed', 'work.review_requested', 'work.ci_failed', 'work.ci_passed', 'work.session', ...TOIL_USAGE_KINDS];
const SIGNAL_TYPES: SignalType[] = ['cycleTime', 'reviewWait', 'rework', 'flakyCi', 'toil', 'handoffs'];
const MAX_EVENTS = 5_000;

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonObject;

export const velocitySignalsNode = defineNode({
  description: {
    name: 'velocitySignals',
    displayName: 'Velocity Signals',
    description: 'Compute how fast software moves from the second brain’s work events: cycle time, review wait, rework, flaky CI, repeated toil and review ping-pong, per repository, and output one item per signal above its threshold',
    version: 1,
    kind: 'action',
    categories: ['AI', 'Core'],
    icon: 'lucide:gauge',
    color: '#8b5cf6',
    subtitle: 'last {{windowDays}} days',
    keywords: ['velocity', 'sdlc', 'cycle time', 'review', 'ci', 'flaky', 'toil', 'second brain', 'dora'],
    inputs: main,
    outputs: main,
    properties: [
      { name: 'windowDays', displayName: 'Window (Days)', type: 'number', default: 14, typeOptions: { minValue: 1, maxValue: 90 }, description: 'How far back the signals look' },
      { name: 'repos', displayName: 'Repositories', type: 'string', default: '', placeholder: 'acme/api, acme/web', description: 'Only these repositories, owner/name, comma-separated (empty: all)' },
      { name: 'types', displayName: 'Signals', type: 'string', default: '', placeholder: SIGNAL_TYPES.join(', '), description: 'Only these signal types, comma-separated (empty: all)' },
    ],
  },
  async execute(ctx) {
    const days = Number(ctx.getNodeParameter('windowDays', 0, 14));
    if (!Number.isFinite(days) || days < 1 || days > 90) throw new NodeOperationError('Window (Days) is 1 to 90');
    const list = (name: string) =>
      String(ctx.getNodeParameter(name, 0, '') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const types = list('types');
    const unknown = types.find((t) => !SIGNAL_TYPES.includes(t as SignalType));
    if (unknown) throw new NodeOperationError(`Unknown signal type “${unknown}”: use ${SIGNAL_TYPES.join(', ')}`);
    const to = Date.now();
    const from = to - Math.floor(days) * DAY_MS;
    // A system reader: it sees the platform's own events and the ones shared with the organization, never a private one.
    const events = listUsageEvents({ kinds: READ_KINDS as never, from: new Date(from).toISOString(), to: new Date(to).toISOString() }, { limit: MAX_EVENTS, scope: { system: true } }).map(signalEventOf);
    const result = velocitySignals(events, { from, to }, { repos: list('repos') });
    const signals = flaggedSignals(result).filter((s) => !types.length || types.includes(s.type));
    return [signals.map((signal) => ({ json: json(signal) }))];
  },
});

const MODEL_TIMEOUT_MS = 90_000;

/** The signal an incoming item carries, or undefined when it isn't one. */
function signalOf(value: JsonObject): Signal | undefined {
  if (typeof value.type !== 'string' || !SIGNAL_TYPES.includes(value.type as SignalType) || typeof value.scope !== 'string' || typeof value.summary !== 'string') return undefined;
  return {
    type: value.type as SignalType,
    scope: value.scope,
    key: typeof value.key === 'string' ? value.key : `${value.type}:${value.scope}`,
    value: Number(value.value) || 0,
    unit: (value.unit as Signal['unit']) ?? 'count',
    threshold: Number(value.threshold) || 0,
    count: Number(value.count) || 0,
    evidence: Array.isArray(value.evidence) ? value.evidence.filter((e): e is string => typeof e === 'string') : [],
    summary: value.summary,
    detail: {},
  };
}

/** The same signal is the same suggestion: one fingerprint per signal type and scope, refreshed each night. */
export const velocityFingerprint = (key: string) => `velocity-${createHash('sha1').update(key).digest('hex').slice(0, 16)}`;

/** The idea for a signal: from the model when there is one and it answers well, else the rule for its type. */
async function ideaFor(signal: Signal, useModel: boolean): Promise<{ idea: FlowIdea; by: 'model' | 'rules' }> {
  if (useModel) {
    try {
      const { brainModel } = await import('../brain/writer');
      const model = brainModel();
      if (model) {
        const turn = await model.generate({
          system: 'You help a company raise its software velocity with automation workflows. Reply with JSON only.',
          messages: [{ role: 'user', content: ideaPrompt(signal) }],
          tools: [],
          responseFormat: 'json',
          signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
        });
        const idea = ideaFromModel(turn.text ?? '', signal);
        if (idea) return { idea, by: 'model' };
      }
    } catch {
      // The model is off, unreachable or answered nonsense: the rule's idea below still helps.
    }
  }
  return { idea: deterministicIdea(signal), by: 'rules' };
}

export const proposeFlowsNode = defineNode({
  description: {
    name: 'proposeFlows',
    displayName: 'Propose Flows',
    description: 'For each velocity signal coming in, propose one workflow that would raise velocity: a title, why, the expected effect and a build prompt. Uses the second brain’s model; without one, a rule per signal type. Output items fit Suggest Improvement',
    version: 1,
    kind: 'action',
    categories: ['AI', 'Core'],
    icon: 'lucide:lightbulb',
    color: '#8b5cf6',
    subtitle: '{{useModel ? "brain model" : "rules"}}',
    keywords: ['propose', 'ideas', 'velocity', 'suggest', 'flows', 'second brain', 'sdlc'],
    inputs: main,
    outputs: main,
    properties: [
      { name: 'useModel', displayName: 'Use the Brain’s Model', type: 'boolean', default: true, description: 'Ask the second brain’s model (LANDFLOW_BRAIN_MODEL) for each idea. Off, or when it fails, a rule per signal type writes it' },
      { name: 'limit', displayName: 'Most Ideas', type: 'number', default: 5, typeOptions: { minValue: 1, maxValue: 20 }, description: 'At most this many ideas per run, the strongest signals first' },
    ],
  },
  async execute(ctx) {
    const useModel = Boolean(ctx.getNodeParameter('useModel', 0, true));
    const limit = Math.max(1, Math.min(20, Math.floor(Number(ctx.getNodeParameter('limit', 0, 5)) || 5)));
    const signals = ctx
      .getInputData()
      .map((item) => signalOf(item.json))
      .filter((s): s is Signal => Boolean(s));
    const out: NodeItem[] = [];
    for (const signal of signals.slice(0, limit)) {
      const { idea, by } = await ideaFor(signal, useModel);
      const proof = signal.evidence.length ? ` Evidence: ${signal.evidence.length} events (${signal.evidence.slice(0, 4).join(', ')}${signal.evidence.length > 4 ? ', …' : ''}).` : '';
      out.push({
        json: json({
          signalKey: signal.key,
          signalType: signal.type,
          fingerprint: velocityFingerprint(signal.key),
          title: idea.title,
          why: `${idea.why}${proof}`.slice(0, 2_000),
          effect: idea.effect,
          buildPrompt: idea.buildPrompt.slice(0, 2_000),
          confidence: by === 'model' ? 0.65 : 0.6,
          risk: 'low',
          by,
          evidence: signal.evidence,
        }),
      });
    }
    return [out];
  },
});
