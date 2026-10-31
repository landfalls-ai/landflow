import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AcknowledgeAlert } from '../src/nodes/acknowledge-alert';
import { NodeOperationError } from '@landflow/sdk';
describe('AcknowledgeAlert node', () => {
    let node;
    let mockContext;
    beforeEach(() => {
        node = new AcknowledgeAlert();
        mockContext = {
            getInputData: vi.fn().mockReturnValue([{ json: { test: 'data' } }]),
            getCredentials: vi.fn(),
            http: vi.fn(),
            getNodeParameter: vi.fn().mockReturnValue('alert123'),
        };
    });
    it('should acknowledge alert successfully', async () => {
        const mockResponse = {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: vi.fn().mockResolvedValue({ silenceID: 'silence123' }),
        };
        mockContext.getCredentials.mockReturnValue({
            url: 'https://grafana.example.com',
            token: 'test-token'
        });
        mockContext.http.mockResolvedValue(mockResponse);
        const result = await node.execute(mockContext);
        expect(result).toHaveLength(1);
        expect(result[0].json.silenceId).toEqual('silence123');
        expect(result[0].json.acknowledged).toBe(true);
        // Verify the HTTP call was made with correct parameters
        expect(mockContext.http).toHaveBeenCalledWith('https://grafana.example.com/api/v2/silence', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer test-token',
                'Content-Type': 'application/json',
            },
            body: expect.any(String),
        });
        // Verify the body contains expected structure
        const callArgs = mockContext.http.mock.calls[0];
        const body = JSON.parse(callArgs[1].body);
        expect(body).toHaveProperty('matchers');
        expect(body).toHaveProperty('startsAt');
        expect(body).toHaveProperty('endsAt');
        expect(body).toHaveProperty('createdBy', 'Landflow');
        expect(body).toHaveProperty('comment', 'Silenced by Landflow plugin');
    });
    it('should throw error when alert ID is missing', async () => {
        mockContext.getNodeParameter.mockReturnValue('');
        await expect(node.execute(mockContext)).rejects.toThrow(NodeOperationError);
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
//# sourceMappingURL=acknowledge-alert.test.js.map