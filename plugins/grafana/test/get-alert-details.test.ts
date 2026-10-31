import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GetAlertDetails } from '../src/nodes/get-alert-details';

describe('GetAlertDetails Node', () => {
  let node: GetAlertDetails;

  beforeEach(() => {
    node = new GetAlertDetails();
  });

  it('should have the correct description', () => {
    expect(node.description.name).toBe('getAlertDetails');
    expect(node.description.displayName).toBe('Get Alert Details');
    expect(node.description.description).toBe('Retrieves detailed information for a specific alert by its ID');
  });
});