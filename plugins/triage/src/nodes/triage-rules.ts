import { NodeOperationError, defineNode } from '@landflow/sdk';
import type { JsonObject } from '@landflow/sdk';
import { evaluateRules, readRules, validateRules } from '../lib/rules';
import { isObj, type Obj } from '../lib/util';

export const TriageRules = defineNode({
  description: {
    name: 'triageRules',
    displayName: 'Triage Rules',
    description: 'Ordered, person-approved rules that send an alert to Bypass, Noise, Ask or on to Evaluate',
    version: 1,
    kind: 'action',
    idempotent: true,
    categories: ['Security', 'Developer Tools'],
    capabilities: ['triage.rules'],
    icon: 'file:triage-rules.svg',
    color: '#10b981',
    inputs: [{ type: 'main' }],
    outputs: [
      { type: 'main', displayName: 'Bypass' },
      { type: 'main', displayName: 'Noise' },
      { type: 'main', displayName: 'Ask' },
      { type: 'main', displayName: 'Evaluate' },
    ],
    properties: [
      { name: 'severityField', displayName: 'Severity Field', type: 'string', default: 'alert.severity' },
      {
        name: 'bypassSeverities',
        displayName: 'Always Open For Severity',
        type: 'multiOptions',
        default: ['sev1'],
        description: 'Checked before any rule. sev1 always bypasses, even if you clear it here',
        options: [
          { name: 'sev1', value: 'sev1' },
          { name: 'sev2', value: 'sev2' },
          { name: 'sev3', value: 'sev3' },
          { name: 'sev4', value: 'sev4' },
        ],
      },
      {
        name: 'rules',
        displayName: 'Rules',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        placeholder: 'Add Rule',
        description: 'Checked in order; the first rule that matches wins. A Noise rule needs the name of the person who approved it',
        groups: [
          {
            name: 'rule',
            displayName: 'Rule',
            values: [
              { name: 'name', displayName: 'Name', type: 'string', default: '', placeholder: 'Nightly backup job failures' },
              {
                name: 'action',
                displayName: 'Action',
                type: 'options',
                default: 'ask',
                options: [
                  { name: 'Always Open', value: 'open', description: 'Send to Bypass: a room opens' },
                  { name: 'Ask On-call', value: 'ask', description: 'Send to Ask' },
                  { name: 'Noise', value: 'noise', description: 'Send to Noise. Needs Approved By' },
                ],
              },
              {
                name: 'match',
                displayName: 'Match',
                type: 'options',
                default: 'all',
                options: [
                  { name: 'All conditions', value: 'all' },
                  { name: 'Any condition', value: 'any' },
                ],
              },
              {
                name: 'conditions',
                displayName: 'Conditions',
                type: 'fixedCollection',
                typeOptions: { multipleValues: true },
                default: {},
                placeholder: 'Add Condition',
                groups: [
                  {
                    name: 'condition',
                    displayName: 'Condition',
                    values: [
                      { name: 'path', displayName: 'Field', type: 'string', default: '', placeholder: 'alert.labels.alertname' },
                      {
                        name: 'operator',
                        displayName: 'Operator',
                        type: 'options',
                        default: 'equals',
                        options: [
                          { name: 'Equals', value: 'equals' },
                          { name: 'Not Equals', value: 'notEquals' },
                          { name: 'Contains', value: 'contains' },
                          { name: 'Matches Regex', value: 'regex', description: 'A pattern, or /pattern/flags' },
                          { name: 'Is In List', value: 'in', description: 'Comma-separated, or a JSON array' },
                          { name: 'Exists', value: 'exists' },
                          { name: 'Does Not Exist', value: 'notExists' },
                        ],
                      },
                      { name: 'value', displayName: 'Value', type: 'string', default: '' },
                    ],
                  },
                ],
              },
              { name: 'approvedBy', displayName: 'Approved By', type: 'string', default: '', placeholder: 'ana@example.com', description: 'The person who reviewed this rule. Required for Noise' },
              { name: 'approvedAt', displayName: 'Approved At', type: 'string', default: '', placeholder: '2026-10-01T09:00:00Z' },
              { name: 'expiresAt', displayName: 'Expires At', type: 'string', default: '', placeholder: '2026-12-01T00:00:00Z', description: 'Optional. After this time the rule is skipped' },
            ],
          },
        ],
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const outputs: Array<Array<{ json: JsonObject; pairedItem: { item: number } }>> = [[], [], [], []];
    if (items.length === 0) return outputs;
    // Rules are node-level: read and check them once. An unapproved Noise rule stops the node, loudly.
    const rules = readRules(ctx.getNodeParameter('rules', 0, {}));
    try {
      validateRules(rules);
    } catch (error) {
      throw new NodeOperationError((error as Error).message, { description: 'Open the rule, enter who approved it, or change its action to Ask On-call.' });
    }
    const now = Date.now();
    for (const [i, item] of items.entries()) {
      const bypass = ctx.getNodeParameter<string[]>('bypassSeverities', i, ['sev1']);
      const field = ctx.getNodeParameter<string>('severityField', i, 'alert.severity') || 'alert.severity';
      const result = evaluateRules(item.json as Obj, rules, Array.isArray(bypass) ? bypass : ['sev1'], field, now);
      const prior = isObj(item.json.triage) ? (item.json.triage as JsonObject) : {};
      const triage: JsonObject = { ...prior };
      if (result.rule) {
        triage.rule = { name: result.rule.name, action: result.rule.action, approvedBy: result.rule.approvedBy };
        triage.matchedAt = new Date(now).toISOString();
      }
      if (result.skipped.length) triage.expiredRules = result.skipped;
      const changed = Object.keys(triage).length > 0;
      outputs[result.output].push({ json: changed ? { ...item.json, triage } : item.json, pairedItem: { item: i } });
    }
    ctx.logger.info(`rules: ${outputs.map((o, n) => `${['bypass', 'noise', 'ask', 'evaluate'][n]}=${o.length}`).join(' ')}`);
    return outputs;
  },
});
