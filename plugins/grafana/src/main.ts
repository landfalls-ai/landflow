import { definePlugin } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';
import { GetAlerts } from './nodes/get-alerts';
import { GetAlertDetails } from './nodes/get-alert-details';
import { AcknowledgeAlert } from './nodes/acknowledge-alert';

export const plugin = definePlugin({
  info: {
    id: 'grafana',
    name: 'Grafana',
    version: '0.1.0',
    description: 'Grafana Alertmanager integration',
    icon: 'file:grafana.svg',
    color: '#e32d5c',
    author: 'Landflow',
  },
  credentialTypes: [
    {
      name: 'grafana_alertmanager_api_token',
      displayName: 'Grafana Alertmanager API Token',
      description: 'API token for Grafana Alertmanager',
      properties: [
        {
          name: 'url',
          displayName: 'Alertmanager URL',
          type: 'string',
          required: true,
          description: 'Grafana Alertmanager API base URL'
        },
        {
          name: 'token',
          displayName: 'API Token',
          type: 'string',
          required: true,
          description: 'API token for authentication'
        }
      ]
    }
  ],
  nodes: [new GetAlerts(), new GetAlertDetails(), new AcknowledgeAlert],
});

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(plugin, {
    http: 7102,
    grpc: 7202,
    host: process.env.LANDFLOW_HOST ?? (process.env.LANDFLOW_ADVERTISE_HOST ? '0.0.0.0' : '127.0.0.1'),
    maxConcurrency: 8,
    mcp: { token: process.env.LANDFLOW_MCP_TOKEN },
  });
}