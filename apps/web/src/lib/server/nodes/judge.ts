/**
 * AI Judge (C13, docs/features/ai.md#ai-judge): reads an item, may look things up with read-only tools, and ends with a decision
 * and a reason. Approve leaves on Approved, deny on Denied; anything uncertain never approves and goes to the fallback: a person
 * (the approval inbox in a run nobody watches, the editor's chat in a person's run), the Needs a person output, or a plain deny.
 * The loop is in judge-loop.ts, the decision schema in judge-schema.ts, which tools may be used in judge-tools.ts.
 */
import { defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type NodeItem } from '@landflow/sdk';
import type { AgentTool } from '@landflow/engine';
import { isEditorRun } from '../../shared/agent-versions';
import { inboxMode } from '../../shared/approval-inbox';
import { DEFAULT_THRESHOLD, FALLBACK_WORDS, JUDGE_LIMITS, judgeTitle, MIN_THRESHOLD, type FallbackReason, type JudgeEvidence } from '../../shared/judge';
import { inboxPort } from '../approval-inbox/port';
import { redactValue } from '../secrets/redact';
import { maskParams } from '../../shared/approval-inbox';
import { approvalSettings, askForApproval, decisionsOf } from './ai';
import { connectedModel } from './fallback';
import { judgeCallId, openJudgeRequest, runGraph, triggerRefusal } from './inbox-run';
import { runJudge, type JudgeOutcome } from './judge-loop';
import { decisionSchema } from './judge-schema';
import { admitTool } from './judge-tools';

const modelInput = { type: 'ai_languageModel' as const, displayName: 'Chat Model', required: true, maxConnections: 1 };
const toolInput = { type: 'ai_tool' as const, displayName: 'Tools', maxConnections: JUDGE_LIMITS.tools };

/** The three outputs (descriptor outputs are static; the third gets items only when the fallback is "Route"). */
const APPROVED = 0;
const DENIED = 1;
const ROUTED = 2;

type Outputs = [NodeItem[], NodeItem[], NodeItem[]];

/** Kept in node state while an item waits for a person. */
interface JudgeState {
  waiting?: { item: number; out: Outputs; fallbackReason: FallbackReason; undecided?: JudgeOutcome['undecided']; rounds: number; toolCalls: number; via: 'inbox' | 'chat' };
  $resume?: { kind: string; data?: JsonObject };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The graph node and descriptor each wired tool comes from, checked by what the platform says about it (judge-tools.ts). */
async function refuseUnsafeTools(ctx: IExecuteContext, tools: AgentTool[]): Promise<void> {
  const { workflow } = await runGraph(ctx.getExecutionId(), ctx.getWorkflowId());
  const { registry } = await import('../plugins/registry');
  const problems: string[] = [];
  for (const tool of tools) {
    const node = tool.nodeId ? workflow?.nodes.find((n) => n.id === tool.nodeId) : undefined;
    const resolved = node ? registry.resolve(node.type) : undefined;
    const source = node && { type: node.type, parameters: (node.parameters ?? {}) as Record<string, unknown>, ...(resolved && !('error' in resolved) && { descriptor: resolved.descriptor }) };
    const admission = admitTool(source, tool.readOnlyHint);
    if (!admission.ok) problems.push(`“${node?.name ?? tool.name}” (${tool.name}): ${admission.why}`);
  }
  if (problems.length) throw new NodeOperationError('The AI Judge only uses read-only tools', { description: problems.join('; ') });
}

export const aiJudgeNode = defineNode({
  description: {
    name: 'aiJudge',
    displayName: 'AI Judge',
    description: 'A model reads an item, may look things up, and decides: Approved, Denied, or a person when it is not sure',
    version: 1,
    kind: 'action',
    categories: ['AI'],
    color: '#a855f7',
    icon: 'lucide:scale',
    keywords: ['judge', 'approve', 'deny', 'decide', 'policy', 'review', 'gate', 'llm'],
    inputs: [{ type: 'main' }, modelInput, toolInput],
    outputs: [
      { type: 'main', displayName: 'Approved' },
      { type: 'main', displayName: 'Denied' },
      { type: 'main', displayName: 'Needs a person' },
    ],
    properties: [
      { name: 'policy', displayName: 'Policy', type: 'string', default: '', required: true, typeOptions: { rows: 8 }, description: `What the judge decides by (up to ${JUDGE_LIMITS.policyChars} characters). It approves only when this clearly allows it.` },
      { name: 'input', displayName: 'Input to Judge', type: 'string', default: '{{ $json }}', typeOptions: { rows: 3 }, description: 'What the judge reads. The item as JSON by default.' },
      { name: 'threshold', displayName: 'Confidence Needed', type: 'number', default: DEFAULT_THRESHOLD, typeOptions: { minValue: MIN_THRESHOLD, maxValue: 1, numberPrecision: 2 }, description: 'Below this the judge never approves: the fallback decides (0.5 to 1)' },
      { name: 'fallback', displayName: 'When It Is Not Sure', type: 'options', default: 'person', noDataExpression: true, options: [
        { name: 'Ask a person', value: 'person', description: 'Wait in Needs you (a run nobody watches) or in the editor chat; Approve continues on Approved, Deny or no answer on Denied' },
        { name: 'Send to “Needs a person”', value: 'route', description: 'The item leaves on the third output for the rest of the flow to handle' },
        { name: 'Deny', value: 'deny', description: 'The item leaves on Denied' },
      ] },
      { name: 'maxRounds', displayName: 'Max Rounds', type: 'number', default: JUDGE_LIMITS.rounds, typeOptions: { minValue: 1, maxValue: JUDGE_LIMITS.rounds }, description: 'Model rounds per item (at most 8)' },
      { name: 'maxToolCalls', displayName: 'Max Tool Calls', type: 'number', default: JUDGE_LIMITS.toolCalls, typeOptions: { minValue: 0, maxValue: JUDGE_LIMITS.toolCalls }, description: 'Tool calls per item in all (at most 12)' },
      { name: 'decisionFields', displayName: 'Extra Decision Fields', type: 'json', default: '', noDataExpression: true, description: 'Optional JSON Schema: { "properties": { "risk": { "type": "string", "enum": ["low", "high"] } } }. The judge must fill them in; a wrong value counts as no decision.' },
    ],
  },
  async execute(ctx) {
    if (!ctx.getInputConnectionData) throw new NodeOperationError('The AI Judge must run in-process');
    const items = ctx.getInputData();
    const saved = ctx.getNodeState?.() as JudgeState | undefined;
    ctx.setNodeState?.(undefined);
    const waited = saved?.waiting && saved.$resume ? saved.waiting : undefined;
    const out: Outputs = waited ? waited.out : [[], [], []];
    if (!items.length) return out;

    const model = await connectedModel(ctx, 'AI Judge');
    const tools = await ctx.getInputConnectionData<AgentTool>('ai_tool');
    if (tools.length > JUDGE_LIMITS.tools) throw new NodeOperationError(`The AI Judge takes at most ${JUDGE_LIMITS.tools} tools; ${tools.length} are connected`);
    await refuseUnsafeTools(ctx, tools);
    const schema = decisionSchema(ctx.getNodeParameter('decisionFields', 0, ''));
    const node = ctx.getNode();
    const name = node.name ?? node.id;
    const editor = isEditorRun(ctx.getMode(), Boolean(ctx.putExecutionToWait));

    for (let i = waited?.item ?? 0; i < items.length; i++) {
      const base = items[i].json;
      const fallback = String(ctx.getNodeParameter('fallback', i, 'person'));
      const place = (output: number, json: JsonObject) => out[output].push({ json: { ...base, ...json }, pairedItem: { item: i } });
      const check = (status: 'pass' | 'warn', message: string, evidence: JsonObject = {}) => ctx.check({ name: 'decision', status, message, subject: name, evidence });

      // Back from a wait: the person's word (or the clock's) settles this item.
      if (waited && i === waited.item) {
        const word = await personsWord(ctx, waited.via, saved!.$resume, i);
        const judged = { ...(waited.undecided && { judgeReason: waited.undecided.reason, judgeConfidence: waited.undecided.confidence }) };
        const common = { decidedBy: word.by, fallbackReason: waited.fallbackReason, rounds: waited.rounds, toolCalls: waited.toolCalls, ...judged };
        if (word.approved) {
          place(APPROVED, { decision: 'approve', reason: `Approved by ${word.by}`, ...common });
          check('pass', `Approved by ${word.by} after the judge could not decide (${FALLBACK_WORDS[waited.fallbackReason]})`);
        } else {
          place(DENIED, { decision: 'deny', reason: word.line, ...common });
          check('warn', `${word.line} (the judge could not decide: ${FALLBACK_WORDS[waited.fallbackReason]})`);
        }
        continue;
      }

      const policy = String(ctx.getNodeParameter('policy', i, '') ?? '').trim();
      if (!policy) throw new NodeOperationError('The AI Judge needs a policy to decide by', { itemIndex: i });
      if (policy.length > JUDGE_LIMITS.policyChars) throw new NodeOperationError(`The policy is longer than ${JUDGE_LIMITS.policyChars} characters`, { itemIndex: i });
      const raw = ctx.getNodeParameter<unknown>('input', i, base);
      // The default (and a blank) mean the item itself, as the descriptor says; anything else is what the builder wrote.
      const subject = typeof raw === 'string' ? (!raw.trim() || raw.trim() === '{{ $json }}' ? base : tryJson(raw)) : raw;
      const outcome = await runJudge({
        model,
        tools,
        policy,
        subject,
        schema,
        limits: { rounds: clamp(Number(ctx.getNodeParameter('maxRounds', i, JUDGE_LIMITS.rounds)) || JUDGE_LIMITS.rounds, 1, JUDGE_LIMITS.rounds), toolCalls: clamp(Number(ctx.getNodeParameter('maxToolCalls', i, JUDGE_LIMITS.toolCalls)) || 0, 0, JUDGE_LIMITS.toolCalls) },
        threshold: clamp(Number(ctx.getNodeParameter('threshold', i, DEFAULT_THRESHOLD)) || DEFAULT_THRESHOLD, MIN_THRESHOLD, 1),
        ...(ctx.signal && { signal: ctx.signal }),
      });
      const counts = { rounds: outcome.rounds, toolCalls: outcome.toolCalls };

      if (outcome.decision) {
        const { decision, reason, confidence, extra } = outcome.decision;
        place(decision === 'approve' ? APPROVED : DENIED, { decision, reason, confidence, ...extra, decidedBy: 'judge', ...counts });
        check(decision === 'approve' ? 'pass' : 'warn', reason, { confidence, ...counts });
        continue;
      }

      // Not decided: never Approved from here.
      const why = outcome.fallbackReason ?? 'no decision';
      const sure = outcome.undecided?.confidence;
      const evidence: JudgeEvidence = { fallbackReason: why, ...counts, steps: outcome.steps, ...(outcome.undecided && { reason: outcome.undecided.reason, confidence: outcome.undecided.confidence, decision: outcome.undecided.decision }) };
      const note = judgeTitle(name, why, sure);
      const fell = { fallbackReason: why, decidedBy: 'judge', ...counts };

      if (fallback === 'route') {
        place(ROUTED, { ...fell, ...(outcome.undecided && { suggestion: { decision: outcome.undecided.decision, reason: outcome.undecided.reason, confidence: outcome.undecided.confidence } }) });
        check('warn', note, counts);
        continue;
      }
      if (fallback === 'deny') {
        place(DENIED, { decision: 'deny', reason: `Could not decide: ${FALLBACK_WORDS[why]}`, ...fell });
        check('warn', note, counts);
        continue;
      }

      // Ask a person. The editor's chat, or the approval inbox in a run nobody watches; a run that cannot wait denies, never approves.
      const wait = ctx.putExecutionToWait ? await waitingPlace(ctx, editor) : undefined;
      if (!wait) {
        place(DENIED, { decision: 'deny', reason: `Could not decide, and this run cannot wait for a person: ${FALLBACK_WORDS[why]}`, ...fell, fallbackReason: 'cannot wait', couldNotDecide: why });
        check('warn', `${note}; ${FALLBACK_WORDS['cannot wait']}, so it was denied`, counts);
        continue;
      }
      const masked = maskParams(redactValue(subject)) as JsonObject;
      const callId = judgeCallId(i);
      const state: JudgeState['waiting'] = { item: i, out, fallbackReason: why, ...(outcome.undecided && { undecided: outcome.undecided }), ...counts, via: wait.via };
      ctx.setNodeState?.({ waiting: state } as unknown as JsonObject);
      if (wait.via === 'inbox') {
        const opened = await openJudgeRequest(ctx, wait.port, { itemIndex: i, subject, evidence });
        await askForApproval(ctx, i, { ...approvalSettings(ctx, i, 'all'), channel: 'chat', timeoutMinutes: 0 }, [{ id: callId, name, input: masked }], { inbox: { ids: opened.ids, expiresAt: opened.expiresAt }, judge: { fallbackReason: why } }, note, opened.expiresAt);
      } else {
        await askForApproval(ctx, i, { ...approvalSettings(ctx, i, 'all'), channel: 'chat', timeoutMinutes: 0 }, [{ id: callId, name, input: masked }], { judge: { fallbackReason: why, ...(outcome.undecided && { reason: outcome.undecided.reason, confidence: outcome.undecided.confidence }) } }, note);
      }
      check('warn', note, counts);
      return out;
    }
    return out;
  },
});

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Where an undecided judge can ask: the editor's chat, the approval inbox, or nowhere (this run cannot wait). */
async function waitingPlace(ctx: IExecuteContext, editor: boolean): Promise<{ via: 'chat' } | { via: 'inbox'; port: NonNullable<ReturnType<typeof inboxPort>> } | undefined> {
  if (editor) return { via: 'chat' };
  if (inboxMode(ctx.getMode()) !== 'inbox' || (await triggerRefusal(ctx.getExecutionId()))) return undefined;
  const port = inboxPort();
  return port ? { via: 'inbox', port } : undefined;
}

/**
 * The person's word on a waiting item. The inbox's record is the truth (read on every resume): a timeout settles a waiting record
 * `expired`; an answer the record does not say fails closed. The chat wait reads the decision the approvals route recorded.
 */
async function personsWord(ctx: IExecuteContext, via: 'inbox' | 'chat', resume: JudgeState['$resume'], itemIndex: number): Promise<{ approved: boolean; by: string; line: string }> {
  const callId = judgeCallId(itemIndex);
  if (via === 'chat') {
    const decision = decisionsOf(resume)[callId];
    if (!decision) throw new NodeOperationError('The AI Judge was resumed without a decision', { itemIndex });
    const by = decision.by ?? 'a person';
    return { approved: decision.approved, by, line: `Denied by ${by}` };
  }
  const port = inboxPort();
  if (!port) throw new NodeOperationError('This host has no approval inbox, so this decision cannot be settled', { itemIndex });
  const executionId = ctx.getExecutionId();
  let outcome = port.outcome(executionId, callId);
  if (!outcome || outcome.status === 'waiting') {
    if (resume?.kind !== 'timeout' && outcome) throw new NodeOperationError('The approval inbox has no decision for this judge', { itemIndex });
    outcome = (await port.settle(executionId, callId, 'expired')).outcome;
  }
  const who = outcome.byName || outcome.by;
  switch (outcome.status) {
    case 'approved':
      return { approved: true, by: who ?? 'a person', line: '' };
    case 'denied':
      return { approved: false, by: who ?? 'a person', line: `Denied by ${who ?? 'a person'}` };
    case 'expired':
      return { approved: false, by: 'expiry', line: 'Nobody decided in time, so it was denied' };
    case 'cancelled':
      return { approved: false, by: 'cancelled', line: 'The run was cancelled, so it was denied' };
    default:
      throw new NodeOperationError('The approval inbox has no decision for this judge', { itemIndex });
  }
}
