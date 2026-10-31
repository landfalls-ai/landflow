export class GetAlertDetails {
    description = {
        name: 'getAlertDetails',
        displayName: 'Get Alert Details',
        description: 'Retrieves detailed information for a specific alert by ID',
        version: 1,
        kind: 'action',
        idempotent: false,
        categories: ['Monitoring'],
        icon: 'file:get-alert-details.svg',
        color: '#f43f5e',
        inputs: [{ type: 'main' }],
        outputs: [{ type: 'main' }],
        usableAsTool: true,
        toolDescription: 'Get detailed information for a specific alert by ID from Grafana Alertmanager API.',
        properties: [
            {
                name: 'credential',
                displayName: 'Credential',
                type: 'credential',
                credentialType: 'grafana_alertmanager_api_token',
                default: '',
                required: true,
            },
            {
                name: 'alertId',
                displayName: 'Alert ID',
                type: 'string',
                required: true,
                description: 'The ID of the alert to retrieve details for',
            },
        ],
    };
    async execute(ctx) {
        const credential = ctx.getCredentials('grafana_alertmanager_api_token');
        const baseUrl = credential.baseUrl;
        const token = credential.token;
        const alertId = ctx.getNodeParameter('alertId', 0);
        try {
            const response = await ctx.helpers.httpRequest({
                url: `${baseUrl}/api/v1/alerts/${alertId}`,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
            });
            if (response.status !== 200) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            const alertDetails = response.body?.data || {};
            return ctx.getInputData().map((item, i) => ({
                json: { ...item.json, alertDetails }
            }));
        }
        catch (error) {
            ctx.logger.error(`Failed to fetch alert details for ID ${alertId}: ${error.message}`);
            throw error;
        }
    }
}
