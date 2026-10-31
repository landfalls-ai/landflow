import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GetAlerts } from '../src/nodes/get-alerts';
describe('GetAlerts Node', () => {
    let node;
    let mockContext;
    beforeEach(() => {
        node = new GetAlerts();
        mockContext = {
            getInputData: vi.fn().mockReturnValue([{ json: {} }]),
            getCredential: vi.fn().mockReturnValue({
                baseUrl: 'http://localhost:9093',
                token: 'test-token'
            }),
            logError: vi.fn(),
        };
    });
    it('should fetch alerts successfully', async () => {
        const mockResponse = {
            status: 200,
            statusText: 'OK',
            body: {
                status: 'success',
                data: {
                    alerts: [
                        {
                            labels: {
                                alertname: 'TestAlert',
                                severity: 'warning'
                            },
                            annotations: {
                                summary: 'Test alert summary'
                            }
                        }
                    ]
                }
            }
        };
        const mockHttp = {
            get: vi.fn().mockResolvedValue(mockResponse)
        };
        // Temporarily replace HttpRequest with our mock
        const originalHttpRequest = (await import('@landflow/sdk/http')).HttpRequest;
        vi.spyOn((await import('@landflow/sdk/http')), 'HttpRequest').mockImplementation(() => mockHttp);
        try {
            await node.execute(mockContext);
            expect(mockHttp.get).toHaveBeenCalledWith('http://localhost:9093/api/v1/alerts?filter=active', expect.any(Object));
        }
        finally {
            vi.restoreAllMocks();
        }
    });
    it('should throw error when API returns non-200 status', async () => {
        const mockResponse = {
            status: 500,
            statusText: 'Internal Server Error'
        };
        const mockHttp = {
            get: vi.fn().mockResolvedValue(mockResponse)
        };
        // Temporarily replace HttpRequest with our mock
        const originalHttpRequest = (await import('@landflow/sdk/http')).HttpRequest;
        vi.spyOn((await import('@landflow/sdk/http')), 'HttpRequest').mockImplementation(() => mockHttp);
        try {
            await expect(node.execute(mockContext)).rejects.toThrow('HTTP 500: Internal Server Error');
        }
        finally {
            vi.restoreAllMocks();
        }
    });
});
