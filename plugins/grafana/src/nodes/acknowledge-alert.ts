import { NodeOperationError, type IExecuteContext, type INodeType, type NodeDescriptor } from '@landflow/sdk';

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
    color: '#60a5fa',
    subtitle: 'Silence an alert to prevent further notifications',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    usableAsTool: true,
    toolDescription: 'Create a silence for the specified alert to prevent further notifications.',
    toolInputSchema: {
      type: 'object',
      properties: {
        alertId: { type: 'string', description: 'The unique identifier of the alert to acknowledge' }
      },
      required: ['alertId'],
    },
    properties: [
      {
        name: 'alertId',
        displayName: 'Alert ID',
        type: 'string',
        required: true,
        description: 'The unique identifier of the alert to acknowledge'
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

    // Construct the silence payload
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
      createdBy: 'Landflow',
      comment: 'Silenced by Landflow plugin'
    };

    // Construct the URL for creating silence
    const silenceUrl = `${url}/api/v2/silence`;

    try {
      const response = await ctx.http(silenceUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(silencePayload),
      });

      if (!response.ok) {
        throw new NodeOperationError(`Failed to acknowledge alert: ${response.status} ${response.statusText}`, {
          description: `HTTP error when acknowledging alert in Grafana Alertmanager API`,
        });
      }

      const silenceResult = await response.json();

      return items.map((item: any) => ({
        json: {
          ...item.json,
          silenceId: silenceResult.silenceID,
          acknowledged: true,
        }
      }));
    } catch (error) {
      throw new NodeOperationError(`Failed to acknowledge alert in Grafana Alertmanager API: ${error instanceof Error ? error.message : String(error)}`, {
        description: 'Could not connect to the Grafana Alertmanager API',
      });
    }
  }
}