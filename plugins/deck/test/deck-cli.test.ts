/** The CLI wrapper against the fake deck: argv without a shell, task on stdin, the pane and binary checks, the trust hint. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DeckError, MAX_TASK_BYTES, checkDeck, deckBinary, dispatch, fetchInbox, inPane } from '../src/deck-cli';
import { useFakeDeck } from './helpers';

afterEach(() => {
  delete process.env.LANDFLOW_DECK_BIN;
  delete process.env.DOT_AGENT_DECK_PANE_ID;
  delete process.env.FAKE_DECK_DIR;
});

describe('dispatch', () => {
  it('runs the deck with an argv array and the task on stdin', async () => {
    const fake = useFakeDeck();
    const result = await dispatch({ name: 'nightly-fix', task: 'do it' });
    expect(result).toEqual({ admitted: true, message: 'Dispatch request sent to the daemon.' });
    expect(fake.calls()).toEqual([{ args: ['dispatch', 'nightly-fix', '--task-file', '-'], stdin: 'do it', inPane: true }]);
  });

  it('hands task text with backticks, quotes, $HOME and newlines over verbatim', async () => {
    const fake = useFakeDeck();
    const task = 'run `rm -rf $HOME`; echo "it\'s" $(whoami)\nline two \\ \'';
    await dispatch({ name: 'verbatim', task });
    expect(fake.calls()[0].stdin).toBe(task);
  });

  it('passes agent, command and dir as separate arguments', async () => {
    const fake = useFakeDeck();
    const dir = mkdtempSync(join(tmpdir(), 'unit-dir-'));
    process.env.LANDFLOW_DECK_ALLOW_COMMAND = '1';
    try {
      await dispatch({ name: 'u1', task: 't', agent: 'claude', command: 'sh -c "echo; exit 0"', dir });
    } finally {
      delete process.env.LANDFLOW_DECK_ALLOW_COMMAND;
    }
    expect(fake.calls()[0].args).toEqual(['dispatch', 'u1', '--task-file', '-', '--agent', 'claude', '--command', 'sh -c "echo; exit 0"', '--dir', dir]);
  });

  it('refuses a command unless the operator allowed commands', async () => {
    const fake = useFakeDeck();
    await expect(dispatch({ name: 'u1', task: 't', command: 'echo hi' })).rejects.toThrow(/LANDFLOW_DECK_ALLOW_COMMAND/);
    expect(fake.calls()).toEqual([]);
  });

  it('refuses a task over 1 MiB before running the deck', async () => {
    const fake = useFakeDeck();
    await expect(dispatch({ name: 'big', task: 'x'.repeat(MAX_TASK_BYTES + 1) })).rejects.toThrow(/1 MiB/);
    expect(fake.calls()).toEqual([]);
    await dispatch({ name: 'big', task: 'x'.repeat(MAX_TASK_BYTES) });
    expect(fake.calls()).toHaveLength(1);
  });

  it('refuses an empty task, a bad name, a bad agent and a relative or missing directory', async () => {
    const fake = useFakeDeck();
    await expect(dispatch({ name: 'ok', task: '  ' })).rejects.toThrow(/task/i);
    for (const name of ['', 'Has Space', 'UPPER', '-x;rm', 'a'.repeat(41)]) await expect(dispatch({ name, task: 't' })).rejects.toThrow(/name/i);
    await expect(dispatch({ name: 'ok', task: 't', agent: 'claude; ls' })).rejects.toThrow(/agent/i);
    await expect(dispatch({ name: 'ok', task: 't', dir: 'relative/dir' })).rejects.toThrow(/absolute/i);
    await expect(dispatch({ name: 'ok', task: 't', dir: '/definitely/not/here-xyz' })).rejects.toThrow(/exist/i);
    expect(fake.calls()).toEqual([]);
  });

  it('fails outside a deck pane naming the requirement, without running the deck', async () => {
    const fake = useFakeDeck({ pane: false });
    await expect(dispatch({ name: 'ok', task: 't' })).rejects.toThrow('run the deck plugin from a deck pane');
    expect(fake.calls()).toEqual([]);
    expect(inPane({})).toBe(false);
    expect(inPane({ DOT_AGENT_DECK_PANE_ID: '' })).toBe(false);
    expect(inPane({ DOT_AGENT_DECK_PANE_ID: '3' })).toBe(true);
  });

  it('says the binary is missing when it is not on PATH', async () => {
    useFakeDeck();
    process.env.LANDFLOW_DECK_BIN = '/nonexistent/dot-agent-deck';
    await expect(dispatch({ name: 'ok', task: 't' })).rejects.toThrow('dot-agent-deck not found on PATH');
    await expect(checkDeck()).resolves.toMatchObject({ ok: false });
    expect(deckBinary()).toBe('/nonexistent/dot-agent-deck');
  });

  it('returns the deck\'s refusal, with its approve hint, when an orchestration is not trusted; it never approves', async () => {
    const fake = useFakeDeck();
    fake.refuse('Error: orchestration "review" is not trusted. Run `dot-agent-deck trust approve review` to approve it.');
    const error = await dispatch({ name: 'ok', task: 't' }).catch((e) => e);
    expect(error).toBeInstanceOf(DeckError);
    expect(error.message).toMatch(/not trusted/);
    expect(error.description).toContain('dot-agent-deck trust approve review');
    expect(fake.calls().every((c) => !c.args.includes('approve'))).toBe(true);
  });
});

describe('fetchInbox', () => {
  it('parses `inbox fetch --json`', async () => {
    const fake = useFakeDeck();
    fake.inbox([{ id: 'a', subject: 's', from: 'f', text: 't' }]);
    expect(await fetchInbox()).toEqual([{ id: 'a', subject: 's', from: 'f', text: 't' }]);
    expect(fake.calls()[0].args).toEqual(['inbox', 'fetch', '--json']);
    expect(await fetchInbox()).toEqual([]);
  });

  it('fails outside a pane', async () => {
    useFakeDeck({ pane: false });
    await expect(fetchInbox()).rejects.toThrow('run the deck plugin from a deck pane');
  });
});
