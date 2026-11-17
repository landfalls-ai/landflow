import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GetAlertDetails } from '../src/nodes/get-alert-details';
import { NodeOperationError } from '@landflow/sdk';

describe('GetAlertDetails node', () => {
  let node: GetAlertDetails;
  let mockContext: any;

  beforeEach(() => {
    node = new GetAlertDetails();

    mockContext = {
      getInputData: vi.fn().mockReturnValue([{ json: { test: 'data' } }]),
      getCredentials: vi.fn(),
      http: vi.fn(),
      getNodeParameter: vi.fn().mockReturnValue('alert123'),
    };
  });

  it('should fetch alert details successfully', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue([{ labels: { alertname: 'alert123', job: 'test' }, annotations: {}, startsAt: '2026-01-01T00:00:00Z', status: { state: 'active' } }]),
    };

    mockContext.getCredentials.mockReturnValue({
      url: 'https://grafana.example.com',
      token: 'test-token'
    });

    mockContext.http.mockResolvedValue(mockResponse);

    const result = await node.execute(mockContext);

    expect(result).toHaveLength(1);
    expect(result[0].json.alertDetails).toEqual({ alertId: 'alert123', labels: { alertname: 'alert123', job: 'test' }, annotations: {}, state: 'active', startsAt: '2026-01-01T00:00:00Z' });
    expect(mockContext.http).toHaveBeenCalledWith('https://grafana.example.com/api/v2/alerts?filter=alertname%3D%22alert123%22', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer test-token',
        'Content-Type': 'application/json',
      },
    });
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