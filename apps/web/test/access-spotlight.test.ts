/** Spotlight knows the access nodes and Ask a Person's two new options (C35-C2 U-6): the parameter lines the builder's prompt carries. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-access-spotlight-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
const { PARAMETER_FORMATS } = await import('@/lib/server/flow-builder');
const line = (type: string) => PARAMETER_FORMATS.split('\n').find((l) => l.startsWith(`- ${type}`)) ?? '';

describe('Spotlight and the access nodes', () => {
  it('names the three access nodes', () => {
    expect(line('core.accessRequestTrigger')).toContain('once per request');
    expect(line('core.accessDecision')).toContain('requestId');
    expect(line('core.accessDecision')).toContain('no request id: it applies nothing');
    expect(line('core.fileAccessRequest')).toContain('only files an access request');
  });
  it('Ask a Person’s line carries Answer Choices and People Only', () => {
    const ask = line('core.confirmDraft');
    expect(ask).toContain('choices');
    expect(ask).toContain('peopleOnly');
  });
  it('says the catalog is edited on the Access page and Spotlight never decides or grants', () => {
    expect(PARAMETER_FORMATS).toMatch(/never approves or grants/);
  });
});
