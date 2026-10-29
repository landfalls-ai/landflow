import { NodeOperationError, defineNode } from '@landflow/sdk';
import type { JsonObject } from '@landflow/sdk';
import { FORMATS, normalizeItem, type AlertFormat, type NormalizeOptions, type Severity } from '../lib/alert';
import { jsonObjectParam, type Obj } from '../lib/util';

const generic = { show: { format: ['generic'] } };

export const NormalizeAlert = defineNode({
  description: {
    name: 'normalizeAlert',
    displayName: 'Normalize Alert',
    description: 'Turn an Alertmanager, Grafana, Datadog, CloudWatch, Sentry or Wazuh alert into one canonical alert',
    version: 1,
    kind: 'action',
    idempotent: true,
    categories: ['Security', 'Developer Tools'],
    icon: 'file:normalize-alert.svg',
    color: '#0ea5e9',
    subtitle: '{{format}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    properties: [
      {
        name: 'format',
        displayName: 'Format',
        type: 'options',
        default: 'auto',
        description: 'The shape of the incoming payload. Auto tries every known format and reads anything else as Generic with the default paths',
        options: [
          { name: 'Auto-detect', value: 'auto' },
          { name: 'Prometheus Alertmanager', value: 'alertmanager', description: 'Webhook v4: one alert per entry of alerts[]' },
          { name: 'Grafana Alerting', value: 'grafana', description: 'Unified alerting webhook' },
          { name: 'Datadog', value: 'datadog', description: 'Webhook with the default payload template' },
          { name: 'AWS CloudWatch (SNS)', value: 'cloudwatch', description: 'Alarm delivered through SNS, Message as a JSON string' },
          { name: 'Sentry', value: 'sentry', description: 'Issue alert / issue webhook' },
          { name: 'Wazuh', value: 'wazuh', description: 'Integration alert JSON' },
          { name: 'Generic', value: 'generic', description: 'Map the fields yourself with dot paths' },
        ],
      },
      { name: 'genericSource', displayName: 'Source Name', type: 'string', default: 'generic', description: 'Goes into alert.source and the dedup key', displayOptions: generic },
      { name: 'titlePath', displayName: 'Title Path', type: 'string', default: 'title', placeholder: 'alert.name', displayOptions: generic },
      { name: 'severityPath', displayName: 'Severity Path', type: 'string', default: 'severity', placeholder: 'alert.level', displayOptions: generic },
      { name: 'servicePath', displayName: 'Service Path', type: 'string', default: 'service', placeholder: 'target.service', displayOptions: generic },
      { name: 'idPath', displayName: 'ID Path', type: 'string', default: 'id', displayOptions: generic },
      { name: 'descriptionPath', displayName: 'Description Path', type: 'string', default: 'description', displayOptions: generic },
      { name: 'statusPath', displayName: 'Status Path', type: 'string', default: 'status', description: 'resolved, ok, recovered and closed count as resolved; anything else is firing', displayOptions: generic },
      { name: 'fingerprintPath', displayName: 'Fingerprint Path', type: 'string', default: '', description: 'Optional. Without one the dedup key is a hash of source, title and service', displayOptions: generic },
      { name: 'environmentPath', displayName: 'Environment Path', type: 'string', default: 'environment', displayOptions: generic },
      {
        name: 'severityMap',
        displayName: 'Severity Map',
        type: 'json',
        default: '{}',
        description:
          'Overrides the built-in mapping, raw value (lower case) to sev1-sev4: {"p2": "sev1", "12": "sev2"}. Built-in: critical/fatal/P1 = sev1, high/error/P2 = sev2, warning/medium/P3 = sev3, info/low/P4/P5 = sev4; Wazuh level 13-15 = sev1, 10-12 = sev2, 7-9 = sev3, 0-6 = sev4; Sentry fatal = sev1, error = sev2, warning = sev3',
        typeOptions: { language: 'json' },
      },
      {
        name: 'defaultSeverity',
        displayName: 'Default Severity',
        type: 'options',
        default: 'sev3',
        description: 'Used when the source gives no severity or one that is not recognised',
        options: [
          { name: 'sev1', value: 'sev1' },
          { name: 'sev2', value: 'sev2' },
          { name: 'sev3', value: 'sev3' },
          { name: 'sev4', value: 'sev4' },
        ],
      },
      { name: 'includeRaw', displayName: 'Keep Raw Payload', type: 'boolean', default: true, description: 'Keep the original payload under alert.raw' },
    ],
  },
  async execute(ctx) {
    const out: Array<{ json: JsonObject; pairedItem: { item: number } }> = [];
    for (const [i, item] of ctx.getInputData().entries()) {
      try {
        const format = ctx.getNodeParameter<string>('format', i, 'auto');
        if (format !== 'auto' && !(FORMATS as readonly string[]).includes(format)) throw new NodeOperationError(`Unknown format "${format}"`, { itemIndex: i });
        let severityMap: Obj;
        try {
          severityMap = jsonObjectParam(ctx.getNodeParameter('severityMap', i, '{}'), 'Severity Map');
        } catch (error) {
          throw new NodeOperationError((error as Error).message, { itemIndex: i });
        }
        const g = (name: string) => ctx.getNodeParameter<string>(name, i, '');
        const options: NormalizeOptions = {
          severityMap: Object.fromEntries(Object.entries(severityMap).map(([k, v]) => [k.toLowerCase(), String(v)])),
          defaultSeverity: ctx.getNodeParameter<Severity>('defaultSeverity', i, 'sev3'),
          generic: {
            source: g('genericSource'),
            titlePath: g('titlePath'),
            severityPath: g('severityPath'),
            servicePath: g('servicePath'),
            idPath: g('idPath'),
            descriptionPath: g('descriptionPath'),
            statusPath: g('statusPath'),
            fingerprintPath: g('fingerprintPath'),
            environmentPath: g('environmentPath'),
          },
        };
        const alerts = normalizeItem(item.json as Obj, format as AlertFormat | 'auto', options, ctx.getNodeParameter<boolean>('includeRaw', i, true));
        for (const alert of alerts) out.push({ json: { alert } as unknown as JsonObject, pairedItem: { item: i } });
      } catch (error) {
        const err = error instanceof NodeOperationError ? error : new NodeOperationError((error as Error).message, { itemIndex: i });
        if (ctx.continueOnFail()) out.push({ json: { error: err.message }, pairedItem: { item: i } });
        else throw err;
      }
    }
    return [out];
  },
});
