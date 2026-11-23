import { describe, expect, it } from 'vitest';
import { isManagedPath, isSafePath, MANIFEST_FILE, SYNC_FORMAT, WORKFLOW_SUFFIX } from '../src';

describe('sync format', () => {
  it('names the format and its manifest', () => {
    expect(SYNC_FORMAT).toBe('landflow-sync/v1');
    expect(MANIFEST_FILE).toBe('landflow-sync.json');
  });

  it('owns the manifest, variables, credentials, table files, workflows and folder files', () => {
    for (const path of [
      'landflow-sync.json',
      'variables.json',
      'credentials.json',
      'data-tables/orders.schema.json',
      'data-tables/orders.rows.json',
      `workflows/a${WORKFLOW_SUFFIX}`,
      `workflows/team/a${WORKFLOW_SUFFIX}`,
      'workflows/team/.folder.json',
    ]) {
      expect(isManagedPath(path), path).toBe(true);
    }
  });

  it('leaves everything else alone', () => {
    for (const path of ['README.md', '.git/config', 'data-tables/a/b.schema.json', 'data-tables/orders.json', 'workflows', 'workflows/a.json', 'other/a.workflow.json']) {
      expect(isManagedPath(path), path).toBe(false);
    }
  });

  it('accepts only relative paths without traversal', () => {
    expect(isSafePath('workflows/a.workflow.json')).toBe(true);
    for (const path of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', 'a/./b', 'a\\b', 'a\0b']) expect(isSafePath(path), JSON.stringify(path)).toBe(false);
  });
});
