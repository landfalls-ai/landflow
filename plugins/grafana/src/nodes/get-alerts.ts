import type { IExecuteContext, INodeType, NodeDescriptor } from '@landflow/sdk';
import { fetch } from 'undici';

export class GetAlerts implements INodeType {
  readonly description: NodeDescriptor = {
    name: 'getAlerts',
    displayName: 'Get Alerts',
    description: 'Fetches active firing alerts from Grafana Alertmanager API',
    version: 1,
    kind: 'action',
    idempotent: true,
    categories: ['Monitoring'],
    icon: 'file:get-alerts.svg',
    color: '#3b82f6',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    usableAsTool: true,
    toolDescription: 'Fetch active firing alerts from Grafana Alertmanager API',
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
      }
    ],
  };

  async execute(ctx: IExecuteContext) {
    const alertmanagerUrl = ctx.getNodeParameter<string>('alertmanagerUrl', 0);
    const apiToken = ctx.getNodeParameter<string>('apiToken', 0);

    // Ensure the URL ends with a slash
    const baseUrl = alertmanagerUrl.endsWith('/') ? alertmanagerUrl : `${alertmanagerUrl}/`;

    try {
      const response = await fetch(`${baseUrl}api/v2/alerts?filter=active`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const alerts = await response.json();

      return ctx.getInputData().map((item, i) => ({
        json: { ...item.json, alerts }
      }));
    } catch (error) {
      // Re-throw the error to be handled by the framework
      throw new Error(`Failed to fetch alerts: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}