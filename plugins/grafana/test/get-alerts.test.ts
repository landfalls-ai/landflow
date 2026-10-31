import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GetAlerts } from '../src/nodes/get-alerts';

describe('GetAlerts Node', () => {
  let node: GetAlerts;

  beforeEach(() => {
    node = new GetAlerts();
  });

  it('should have the correct description', () => {
    expect(node.description.name).toBe('getAlerts');
    expect(node.description.displayName).toBe('Get Alerts');
    expect(node.description.description).toBe('Fetches active firing alerts from Grafana Alertmanager API');
  });
});