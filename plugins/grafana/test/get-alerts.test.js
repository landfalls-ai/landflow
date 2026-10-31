import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GetAlerts } from '../src/nodes/get-alerts';
import { NodeOperationError } from '@landflow/sdk';
describe('GetAlerts node', () => {
    let node;
    let mockContext;
    beforeEach(() => {
        node = new GetAlerts();
        mockContext = {
            getInputData: vi.fn().mockReturnValue([{ json: { test: 'data' } }]),
            getCredentials: vi.fn(),
            http: vi.fn(),
            getNodeParameter: vi.fn(),
        };
    });
    it('should fetch alerts successfully', async () => {
        const mockResponse = {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: vi.fn().mockResolvedValue([{ id: 'alert1', status: 'firing' }]),
        };
        mockContext.getCredentials.mockReturnValue({
            url: 'https://grafana.example.com',
            token: 'test-token'
        });
        mockContext.http.mockResolvedValue(mockResponse);
        const result = await node.execute(mockContext);
        expect(result).toHaveLength(1);
        expect(result[0].json.alerts).toEqual([{ id: 'alert1', status: 'firing' }]);
        expect(mockContext.http).toHaveBeenCalledWith('https://grafana.example.com/api/v2/alerts?active=true&silenced=false&inhibited=false', {
            method: 'GET',
            headers: {
                'Authorization': 'Bearer test-token',
                'Content-Type': 'application/json',
            },
        });
    });
    it('should throw error when URL is missing', async () => {
        mockContext.getCredentials.mockReturnValue({
            url: '',
            token: 'test-token'
        });
        await expect(node.execute(mockContext)).rejects.toThrow(NodeOperationError);
    });
    it('should throw error when token is missing', async () => {
        mockContext.getCredentials.mockReturnValue({
            url: 'https://grafana.example.com',
            token: ''
        });
        await expect(node.execute(mockContext)).rejects.toThrow(NodeOperationError);
    });
    it('should handle HTTP errors gracefully', async () => {
        const mockResponse = {
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
        };
        mockContext.getCredentials.mockReturnValue({
            url: 'https://grafana.example.com',
            token: 'test-token'
        });
        mockContext.http.mockResolvedValue(mockResponse);
        await expect(node.execute(mockContext)).rejects.toThrow(NodeOperationError);
    });
});
//# sourceMappingURL=get-alerts.test.js.map