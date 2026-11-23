/** The harness registry (C15 AS-1, C04 FR-3): unique entries, events only where a harness sends them, the status table. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONNECT_HARNESS_IDS, HARNESS_REGISTRY, KAGENT_RUNTIME_LABELS, harnessById, sendsEvents, statusFor } from '../src/harnesses';

const claude = harnessById('claude-code')!;

describe('registry', () => {
  it('has unique ids, labels and strategies, and the eight entries of C15 FR-2', () => {
    const ids = HARNESS_REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(['claude-code', 'claude-desktop', 'codex', 'cursor', 'gemini', 'generic', 'opencode', 'vscode']);
    for (const entry of HARNESS_REGISTRY) {
      expect(entry.label).toBeTruthy();
      expect(entry.strategy).toBeTruthy();
      if (entry.hookEvents) expect(sendsEvents(entry)).toBe(true);
      else expect(sendsEvents(entry)).toBe(false);
    }
  });
  it('lets only Claude Code (native hooks) and Codex (a wrapper that watches its rollout files, C08) carry hookEvents', () => {
    expect(HARNESS_REGISTRY.filter(sendsEvents).map((e) => e.id)).toEqual(['claude-code', 'codex']);
    for (const entry of HARNESS_REGISTRY.filter((e) => e.strategy === 'mcp-only')) expect(entry.hookEvents).toBeUndefined();
  });
  it('Codex accepts exactly one event, quota_blocked, as Blocked; every other name is unlisted (counted unknown) and the entry stays unverified', () => {
    const codex = harnessById('codex')!;
    expect(codex).toMatchObject({ strategy: 'wrapper', statusSignals: 'rollout-file', verified: false });
    expect(Object.keys(codex.hookEvents!)).toEqual(['quota_blocked']);
    expect(statusFor(codex, 'quota_blocked', {})).toBe('blocked');
    for (const name of ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreToolUse', 'quota_blocked_extra']) expect(statusFor(codex, name, {}), name).toBeUndefined();
  });
  it('lists the six /connect harnesses in order, all registered, and one wording for the kagent runtimes', () => {
    expect([...CONNECT_HARNESS_IDS]).toEqual(['claude-code', 'cursor', 'codex', 'gemini', 'vscode', 'generic']);
    for (const id of CONNECT_HARNESS_IDS) expect(harnessById(id)).toBeDefined();
    expect(KAGENT_RUNTIME_LABELS).toEqual({ kagent: 'kagent (ADK)', claude: 'Claude Code', codex: 'Codex', byo: 'Own image' });
    expect(claude.kagentRuntime).toBe('claude');
    expect(harnessById('codex')!.kagentRuntime).toBe('codex');
  });
  it('imports nothing (browser-safe, no zod at load)', () => {
    expect(readFileSync(new URL('../src/harnesses.ts', import.meta.url), 'utf8')).not.toMatch(/^import /m);
  });
});

describe('statusFor (C04 FR-3)', () => {
  const status = (name: string, payload: Record<string, unknown> = {}) => statusFor(claude, name, payload);
  it('maps the events', () => {
    expect(status('UserPromptSubmit')).toBe('thinking');
    expect(status('PreToolUse')).toBe('working');
    expect(status('PostToolUse')).toBe('thinking');
    expect(status('PostToolUseFailure')).toBe('thinking');
    expect(status('PreCompact')).toBe('compacting');
    expect(status('PostCompact')).toBe('thinking');
    expect(status('PermissionRequest')).toBe('waiting');
    expect(status('Stop')).toBe('idle');
    expect(status('SessionStart')).toBe('idle');
    expect(status('StopFailure')).toBe('error');
    expect(status('SessionEnd')).toBe('ended');
  });
  it('maps Notification by notification_type', () => {
    expect(status('Notification', { notification_type: 'permission_prompt' })).toBe('waiting');
    expect(status('Notification', { notification_type: 'idle_prompt' })).toBe('idle');
    expect(status('Notification', { notification_type: 'auth_success' })).toBe('keep');
  });
  it('answers undefined for a name the entry does not list, and for a prototype key', () => {
    expect(status('SomethingNew')).toBeUndefined();
    expect(status('constructor')).toBeUndefined();
    expect(statusFor(harnessById('cursor')!, 'Stop', {})).toBeUndefined();
  });
});
