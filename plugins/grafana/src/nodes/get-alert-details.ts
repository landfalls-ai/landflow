import type { IExecuteContext, INodeType, NodeDescriptor } from '@landflow/sdk';
import { fetch } from 'undici';

export class GetAlertDetails implements INodeType {
  readonly description: NodeDescriptor = {
    name: 'getAlertDetails',
    displayName: 'Get Alert Details',
    description: 'Retrieves detailed information for a specific alert by its ID',
    version: 1,
    kind: 'action',
    idempotent: true,
    categories: ['Monitoring'],
    icon: 'file:get-alert-details.svg',
    color: '#8b5cf6',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    usableAsTool: true,
    toolDescription: 'Get detailed information for a specific alert by its ID',
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
        description: 'ID of the alert to retrieve details for'
      }
    ],
  };

  async execute(ctx: IExecuteContext) {
    const alertmanagerUrl = ctx.getNodeParameter<string>('alertmanagerUrl', 0);
    const apiToken = ctx.getNodeParameter<string>('apiToken', 0);
    const alertId = ctx.getNodeParameter<string>('alertId', 0);

    // Ensure the URL ends with a slash
    const baseUrl = alertmanagerUrl.endsWith('/') ? alertmanagerUrl : `${alertmanagerUrl}/`;

    try {
      const response = await fetch(`${baseUrl}api/v2/alerts/${alertId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const alertDetails = await response.json();

      return ctx.getInputData().map((item, i) => ({
        json: { ...item.json, alertDetails }
      }));
    } catch (error) {
      // Re-throw the error to be handled by the framework
      throw new Error(`Failed to fetch alert details: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}