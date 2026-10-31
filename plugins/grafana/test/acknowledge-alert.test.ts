import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AcknowledgeAlert } from '../src/nodes/acknowledge-alert';

describe('AcknowledgeAlert Node', () => {
  let node: AcknowledgeAlert;

  beforeEach(() => {
    node = new AcknowledgeAlert();
  });

  it('should have the correct description', () => {
    expect(node.description.name).toBe('acknowledgeAlert');
    expect(node.description.displayName).toBe('Acknowledge Alert');
    expect(node.description.description).toBe('Acknowledges or silences a specific alert in Grafana Alertmanager');
  });
});