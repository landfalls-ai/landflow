import { NodeOperationError, type IExecuteContext, type INodeType, type NodeDescriptor } from '@landflow/sdk';

export class GetAlertDetails implements INodeType {
  readonly description: NodeDescriptor = {
    name: 'getAlertDetails',
    displayName: 'Get Alert Details',
    description: 'Retrieves detailed information for a specific alert by its ID',
    version: 1,
    kind: 'action',
    idempotent: false,
    categories: ['Monitoring'],
    icon: 'file:get-alert-details.svg',
    color: '#60a5fa',
    subtitle: 'Get details for a specific alert',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    usableAsTool: true,
    toolDescription: 'Retrieve detailed information for a specific alert by its ID.',
    toolInputSchema: {
      type: 'object',
      properties: {
        alertId: { type: 'string', description: 'The unique identifier of the alert' }
      },
      required: ['alertId'],
    },
    properties: [
      {
        name: 'alertId',
        displayName: 'Alert ID',
        type: 'string',
        required: true,
        description: 'The unique identifier of the alert to retrieve details for'
      }
    ],
  };

  async execute(ctx: IExecuteContext) {
    const items = ctx.getInputData();
    const alertId = ctx.getNodeParameter('alertId', 0);

    if (!alertId) {
      throw new NodeOperationError('Alert ID is required', {
        description: 'The "alertId" parameter must be provided.',
      });
    }

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

    // Construct the URL for fetching alert details
    const alertUrl = `${url}/api/v2/alerts/${alertId}`;

    try {
      const response = await ctx.http(alertUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new NodeOperationError(`Failed to fetch alert details: ${response.status} ${response.statusText}`, {
          description: `HTTP error when fetching alert details from Grafana Alertmanager API`,
        });
      }

      const alertDetails = await response.json();

      return items.map((item) => ({
        json: {
          ...item.json,
          alertDetails: alertDetails,
        }
      }));
    } catch (error) {
      throw new NodeOperationError(`Failed to fetch alert details from Grafana Alertmanager API: ${error instanceof Error ? error.message : String(error)}`, {
        description: 'Could not connect to the Grafana Alertmanager API',
      });
    }
  }
}