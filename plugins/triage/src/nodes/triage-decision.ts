import { defineNode } from '@landflow/sdk';
import type { JsonObject } from '@landflow/sdk';
import { decide, summarize, type DecisionConfig } from '../lib/decision';
import { getPath, isObj, str, type Obj } from '../lib/util';

export const TriageDecision = defineNode({
  description: {
    name: 'triageDecision',
    displayName: 'Triage Decision',
    description: 'The policy gate after the AI verdict: open a room, attach to an open one or ask on-call. It cannot drop an alert',
    version: 1,
    kind: 'action',
    idempotent: true,
    categories: ['Security', 'Developer Tools'],
    icon: 'file:triage-decision.svg',
    color: '#ef4444',
    subtitle: '{{mode}}',
    inputs: [{ type: 'main' }],
    outputs: [
      { type: 'main', displayName: 'Open' },
      { type: 'main', displayName: 'Attach' },
      { type: 'main', displayName: 'Ask' },
    ],
    properties: [
      {
        name: 'mode',
        displayName: 'Mode',
        type: 'options',
        default: 'shadow',
        description: 'Shadow opens a room for everything and only records what Enforce would have done. Run Shadow first',
        options: [
          { name: 'Shadow', value: 'shadow' },
          { name: 'Enforce', value: 'enforce' },
        ],
      },
      { name: 'verdictField', displayName: 'Verdict Field', type: 'string', default: 'verdict', description: 'Dot path to the AI verdict: an object, or JSON text (markdown code fences are fine). `output` is used when this is empty' },
      { name: 'minConfidence', displayName: 'Minimum Confidence', type: 'number', default: 0.7, typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 }, description: 'Below this the alert goes to Ask' },
      { name: 'existingRoomField', displayName: 'Existing Room Field', type: 'string', default: 'group.dedupKey', description: 'Dot path to the dedup key of an open room for this alert. Empty means there is none' },
      { name: 'severityField', displayName: 'Severity Field', type: 'string', default: 'alert.severity' },
    ],
  },
  async execute(ctx) {
    const outputs: Array<Array<{ json: JsonObject; pairedItem: { item: number } }>> = [[], [], []];
    for (const [i, item] of ctx.getInputData().entries()) {
      const json = item.json as Obj;
      const mode = ctx.getNodeParameter<string>('mode', i, 'shadow') === 'enforce' ? 'enforce' : 'shadow';
      const min = Number(ctx.getNodeParameter('minConfidence', i, 0.7));
      const cfg: DecisionConfig = {
        mode,
        verdictField: ctx.getNodeParameter<string>('verdictField', i, 'verdict') || 'verdict',
        minConfidence: Number.isFinite(min) ? min : 0.7,
        existingRoomField: ctx.getNodeParameter<string>('existingRoomField', i, 'group.dedupKey'),
        severityField: ctx.getNodeParameter<string>('severityField', i, 'alert.severity') || 'alert.severity',
      };
      let outcome: 'open' | 'attach' | 'ask';
      let triage: JsonObject;
      try {
        const d = decide(json, cfg);
        outcome = d.outcome;
        const dedupKey = outcome === 'attach' && d.existingRoom ? d.existingRoom : str(getPath(json, 'alert.dedupKey')) || null;
        triage = {
          ...(isObj(json.triage) ? (json.triage as JsonObject) : {}),
          outcome,
          mode,
          ...(mode === 'shadow' && { shadowOutcome: d.enforceOutcome }),
          verdict: d.verdict?.verdict ?? null,
          confidence: d.verdict?.confidence ?? null,
          reasons: d.reasons,
          ...(d.verdict?.suggestedSeverity && { suggestedSeverity: d.verdict.suggestedSeverity }),
          ...(d.failedOpen && { failedOpen: true }),
          decidedAt: new Date().toISOString(),
          policy: 'v1',
          summary: summarize(json, d, mode),
          dedupKey,
        };
      } catch (error) {
        // Never let a bug in the gate swallow an alert: fail open.
        outcome = 'open';
        triage = {
          outcome,
          mode,
          verdict: null,
          confidence: null,
          reasons: [`fail open: ${(error as Error).message}`],
          failedOpen: true,
          decidedAt: new Date().toISOString(),
          policy: 'v1',
          summary: 'Opening a room: the triage gate failed, so the alert fails open.',
          dedupKey: str(getPath(json, 'alert.dedupKey')) || null,
        };
      }
      outputs[outcome === 'open' ? 0 : outcome === 'attach' ? 1 : 2].push({ json: { ...item.json, triage }, pairedItem: { item: i } });
    }
    ctx.logger.info(`decision: open=${outputs[0].length} attach=${outputs[1].length} ask=${outputs[2].length}`);
    return outputs;
  },
});
