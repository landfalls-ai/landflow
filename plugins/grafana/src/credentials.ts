import { defineCredentialType } from '@landflow/sdk';

export const GrafanaCredential = defineCredentialType({
  name: 'grafana_alertmanager_api_token',
  displayName: 'Grafana Alertmanager API Token',
  documentationUrl: 'https://grafana.com/docs/grafana/latest/alerting/',
  icon: 'file:grafana.svg',
  color: '#f43f5e',
  properties: [
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: 'http://localhost:9093',
      required: true,
      description: 'The base URL of the Grafana Alertmanager API endpoint (e.g., http://localhost:9093)',
    },
    {
      displayName: 'API Token',
      name: 'token',
      type: 'string',
      required: true,
      description: 'The API token for authenticating with the Alertmanager API',
    },
  ],
});