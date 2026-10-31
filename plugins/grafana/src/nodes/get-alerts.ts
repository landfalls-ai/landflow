import { NodeOperationError, type IExecuteContext, type INodeType, type NodeDescriptor } from '@landflow/sdk';

export class GetAlerts implements INodeType {
  readonly description: NodeDescriptor = {
    name: 'getAlerts',
    displayName: 'Get Alerts',
    description: 'Fetches active firing alerts from Grafana Alertmanager API',
    version: 1,
    kind: 'action',
    idempotent: false,
    categories: ['Monitoring'],
    icon: 'file:get-alerts.svg',
    color: '#60a5fa',
    subtitle: 'Get currently firing alerts',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    usableAsTool: true,
    toolDescription: 'Retrieve currently firing alerts from Grafana Alertmanager.',
    toolInputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    properties: [],
  };

  async execute(ctx: IExecuteContext) {
    const items = ctx.getInputData();

    // Get the credential data
    const credentials = ctx.getCredentials('grafana_alertmanager_api_token');
    const url = credentials.url;
    const token = credentials.token;

    if (!url) {
      throw new NodeOperationError('Grafana Alertmanager URL is required', {
        description: 'The "url" field in the credential is missing.',
      });
    }

    if (!token) {
      throw new NodeOperationError('Grafana API token is required', {
        description: 'The "token" field in the credential is missing.',
      });
    }

    // Construct the URL for fetching alerts
    const alertUrl = `${url}/api/v2/alerts?active=true&silenced=false&inhibited=false`;

    try {
      const response = await ctx.http(alertUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new NodeOperationError(`Failed to fetch alerts: ${response.status} ${response.statusText}`, {
          description: `HTTP error when fetching alerts from Grafana Alertmanager API`,
        });
      }

      const alerts = await response.json();

      return items.map((item) => ({
        json: {
          ...item.json,
          alerts: alerts,
        }
      }));
    } catch (error) {
      throw new NodeOperationError(`Failed to fetch alerts from Grafana Alertmanager API: ${error instanceof Error ? error.message : String(error)}`, {
        description: 'Could not connect to the Grafana Alertmanager API',
      });
    }
  }
}