export class AcknowledgeAlert {
    description = {
        name: 'acknowledgeAlert',
        displayName: 'Acknowledge Alert',
        description: 'Acknowledges or silences a specific alert',
        version: 1,
        kind: 'action',
        idempotent: false,
        categories: ['Monitoring'],
        icon: 'file:acknowledge-alert.svg',
        color: '#f43f5e',
        inputs: [{ type: 'main' }],
        outputs: [{ type: 'main' }],
        usableAsTool: true,
        toolDescription: 'Acknowledge or silence a specific alert in Grafana Alertmanager API.',
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
                description: 'The ID of the alert to acknowledge',
            },
            {
                name: 'duration',
                displayName: 'Duration (seconds)',
                type: 'number',
                default: 3600,
                description: 'Duration in seconds for which to silence the alert',
            },
        ],
    };
    async execute(ctx) {
        const credential = ctx.getCredentials('grafana_alertmanager_api_token');
        const baseUrl = credential.baseUrl;
        const token = credential.token;
        const alertId = ctx.getNodeParameter('alertId', 0);
        const duration = ctx.getNodeParameter('duration', 0);
        try {
            // Create silence for the alert
            const silencePayload = {
                matchers: [
                    {
                        name: 'alertname',
                        value: alertId,
                        isRegex: false,
                    }
                ],
                startsAt: new Date().toISOString(),
                endsAt: new Date(Date.now() + (duration * 1000)).toISOString(),
                createdBy: 'landflow-plugin',
                comment: `Silenced by Landflow for ${duration} seconds`
            };
            const response = await ctx.helpers.httpRequest({
                url: `${baseUrl}/api/v1/silences`,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(silencePayload),
            });
            if (response.status !== 200 && response.status !== 201) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            const silenceId = response.body?.data?.silenceID || null;
            return ctx.getInputData().map((item, i) => ({
                json: { ...item.json, acknowledged: true, silenceId }
            }));
        }
        catch (error) {
            ctx.logger.error(`Failed to acknowledge alert ${alertId}: ${error.message}`);
            throw error;
        }
    }
}
