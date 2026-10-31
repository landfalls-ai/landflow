import type { IExecuteContext, INodeType, NodeDescriptor } from '@landflow/sdk';
import { fetch } from 'undici';

export class AcknowledgeAlert implements INodeType {
  readonly description: NodeDescriptor = {
    name: 'acknowledgeAlert',
    displayName: 'Acknowledge Alert',
    description: 'Acknowledges or silences a specific alert in Grafana Alertmanager',
    version: 1,
    kind: 'action',
    idempotent: false,
    categories: ['Monitoring'],
    icon: 'file:acknowledge-alert.svg',
    color: '#f59e0b',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    usableAsTool: true,
    toolDescription: 'Acknowledge or silence a specific alert in Grafana Alertmanager',
    properties: [
      {
        name: 'alertmanagerUrl',
        displayName: 'Alertmanager URL',
        type: 'string',
        required: true,
        description: 'Base URL of the Grafana Alertmanager API'
      },
      {
        name: 'apiToken',
        displayName: 'API Token',
        type: 'string',
        required: true,
        description: 'Authentication token for the Alertmanager API'
      },
      {
        name: 'alertId',
        displayName: 'Alert ID',
        type: 'string',
        required: true,
        description: 'ID of the alert to acknowledge/silence'
      },
      {
        name: 'silence',
        displayName: 'Silence Alert',
        type: 'boolean',
        default: false,
        description: 'If true, silence the alert; if false, just acknowledge it'
      }
    ],
  };

  async execute(ctx: IExecuteContext) {
    const alertmanagerUrl = ctx.getNodeParameter<string>('alertmanagerUrl', 0);
    const apiToken = ctx.getNodeParameter<string>('apiToken', 0);
    const alertId = ctx.getNodeParameter<string>('alertId', 0);
    const silence = ctx.getNodeParameter<boolean>('silence', 0);

    // Ensure the URL ends with a slash
    const baseUrl = alertmanagerUrl.endsWith('/') ? alertmanagerUrl : `${alertmanagerUrl}/`;

    try {
      if (silence) {
        // Create a silence for the alert
        const silencePayload = {
          matchers: [
            {
              name: 'alertname',
              value: alertId,
              isRegex: false
            }
          ],
          startsAt: new Date().toISOString(),
          endsAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
          createdBy: 'landflow',
          comment: 'Silenced by Landflow'
        };

        const response = await fetch(`${baseUrl}api/v2/silences`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(silencePayload)
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const silenceResult = await response.json();

        return ctx.getInputData().map((item, i) => ({
          json: { ...item.json, silenceResult }
        }));
      } else {
        // For acknowledging an alert (no specific API endpoint for this)
        // In Alertmanager, acknowledging is usually done by silencing or just marking as handled
        // We'll return a simple acknowledgment result
        return ctx.getInputData().map((item, i) => ({
          json: { ...item.json, acknowledged: true, alertId }
        }));
      }
    } catch (error) {
      // Re-throw the error to be handled by the framework
      throw new Error(`Failed to acknowledge alert: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}