import type { IExecuteContext, INodeType, NodeDescriptor } from '@landflow/sdk';

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
    color: '#f43f5e',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    usableAsTool: true,
    toolDescription: 'Get active alerts from Grafana Alertmanager API. Returns a list of active alerts.',
    properties: [
      {
        name: 'credential',
        displayName: 'Credential',
        type: 'credential',
        credentialType: 'grafana_alertmanager_api_token',
        default: '',
        required: true,
      },
    ],
  };

  async execute(ctx: IExecuteContext) {
    const credential = ctx.getCredentials('grafana_alertmanager_api_token');
    const baseUrl = credential.baseUrl;
    const token = credential.token;

    try {
      const response = await ctx.helpers.httpRequest({
        url: `${baseUrl}/api/v1/alerts?filter=active`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const alerts = response.body?.data?.alerts || [];

      return ctx.getInputData().map((item, i) => ({
        json: { ...item.json, alerts }
      }));
    } catch (error) {
      ctx.logger.error(`Failed to fetch alerts: ${(error as Error).message}`);
      throw error;
    }
  }
}