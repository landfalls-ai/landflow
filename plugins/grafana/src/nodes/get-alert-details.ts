import { NodeOperationError, type IExecuteContext, type INodeType, type NodeDescriptor } from '@landflow/sdk';

export class GetAlertDetails implements INodeType {
  readonly description: NodeDescriptor = {
    name: 'getAlertDetails',
    displayName: 'Get Alert Details',
    description: 'Retrieves detailed information for a specific firing alert by its name (its alertname label)',
    version: 1,
    kind: 'action',
    idempotent: true,
    credentials: [{ name: 'grafana_alertmanager_api_token', required: true }],
    categories: ['Monitoring'],
    icon: 'file:get-alert-details.svg',
    color: '#60a5fa',
    subtitle: 'Get details for a specific alert',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    usableAsTool: true,
    toolDescription: 'Retrieve detailed information for a specific alert by its name (its alertname label), not its fingerprint.',
    toolInputSchema: {
      type: 'object',
      properties: {
        alertId: { type: 'string', description: "The alert's name (its alertname label, e.g. High CPU on web-01), not its fingerprint" }
      },
      required: ['alertId'],
    },
    properties: [
      {
        name: 'alertId',
        displayName: 'Alert Name',
        type: 'string',
        required: true,
        description: "The alert's name (its alertname label, e.g. High CPU on web-01), not its fingerprint"
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
    // AG10: Alertmanager v2 has no alert-by-id path; the list takes a filter, so the alert is found by its name.
    const alertUrl = `${String(url).replace(/\/+$/, '')}/api/v2/alerts?filter=${encodeURIComponent(`alertname="${alertId.replace(/[\\"]/g, '\\$&')}"`)}`;

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

      const found = (await response.json()) as Array<{ labels?: Record<string, string>; annotations?: Record<string, string>; startsAt?: string; endsAt?: string; fingerprint?: string; status?: { state?: string } }>;
      const first = Array.isArray(found) ? found[0] : undefined;
      if (!first) {
        throw new NodeOperationError(`No firing alert named ${alertId}`, { description: 'Alertmanager has no active alert with this alertname.' });
      }
      const alertDetails = {
        alertId,
        labels: first.labels ?? {},
        annotations: first.annotations ?? {},
        state: first.status?.state ?? null,
        startsAt: first.startsAt ?? null,
        ...(first.fingerprint && { fingerprint: first.fingerprint }),
      };

      return items.map((item: any) => ({
        json: {
          ...item.json,
          alertDetails: alertDetails,
        }
      }));
    } catch (error) {
      if (error instanceof NodeOperationError) throw error;
      throw new NodeOperationError(`Failed to fetch alert details from Grafana Alertmanager API: ${error instanceof Error ? error.message : String(error)}`, {
        description: 'Could not connect to the Grafana Alertmanager API',
      });
    }
  }
}