import { homedir, userInfo } from 'node:os';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runNode, type JsonObject } from '@landflow/sdk';
import type { BinaryRef, ExecuteRequest } from '@landflow/protocol';
import { AgentShell } from '../src/nodes/agent-shell';
import { plugin } from '../src/main';
import { LIMITS, clearSessions, runShell, seedPath, sessionCount } from '../src/shell';

const CANARY_ENV = 'sk-live-agent-shell-canary-9f3a';
const CANARY_FILE = 'host-file-canary-b71c';
let hostDir = '';

beforeAll(() => {
  process.env.LANDFLOW_AGENT_SHELL_TEST_SECRET = CANARY_ENV;
  process.env.AWS_SECRET_ACCESS_KEY = CANARY_ENV;
  hostDir = mkdtempSync(join(tmpdir(), 'agent-shell-'));
  writeFileSync(join(hostDir, 'secret.txt'), CANARY_FILE);
});
afterEach(() => clearSessions());

const inline = (text: string, fileName: string): BinaryRef => {
  const bytes = Buffer.from(text);
  return { mimeType: 'text/plain', fileName, fileSize: bytes.length, data: bytes.toString('base64') };
};

function request(parameters: JsonObject, items: Array<{ json: JsonObject; binary?: Record<string, BinaryRef> }> = [{ json: {} }], executionId = 'ex_test'): ExecuteRequest {
  return {
    protocol: 'landflow.plugin/v1',
    executionId,
    workflowId: 'wf_test',
    mode: 'manual',
    node: { id: 'n1', name: 'Shell', type: 'agent-shell.agentShell', typeVersion: 1 },
    parameters,
    itemParameters: items.map(() => parameters),
    inputs: [items],
  };
}
const extras = { credentialTypes: plugin.credentialTypes, pluginId: 'agent-shell' };
async function call(parameters: JsonObject, items?: Parameters<typeof request>[1], executionId?: string) {
  const response = await runNode(new AgentShell(), request(parameters, items, executionId), extras);
  return response;
}
const base = { files: '{}', useBinary: true, options: {} };

describe('the node as an agent tool', () => {
  const description = new AgentShell().description;
  it('is usable as a tool with a command and files input', () => {
    expect(description.usableAsTool).toBe(true);
    expect(description.toolInputSchema).toMatchObject({ required: ['command'], properties: { command: { type: 'string' }, files: { type: 'object' } } });
    expect(plugin.info.id).toBe('agent-shell');
  });

  it('lists and reads files it was given (an agent-style call: arguments arrive in the item)', async () => {
    const files = { 'notes.txt': 'alpha\nbeta\n', 'data/users.csv': 'name,age\nAda,36\nLin,41\n' };
    // The tool's arguments arrive in the item (`files`) and as the `command` parameter.
    const ls = await call({ ...base, command: 'ls -R && cat notes.txt && grep Ada data/users.csv' }, [{ json: { files } }]);
    expect(ls.error).toBeUndefined();
    const json = ls.outputs[0][0].json as { stdout: string; exitCode: number; files: unknown[] };
    expect(json.exitCode).toBe(0);
    expect(json.stdout).toContain('notes.txt');
    expect(json.stdout).toContain('users.csv');
    expect(json.stdout).toContain('alpha\nbeta');
    expect(json.stdout).toContain('Ada,36');
    expect(json.files).toEqual([]); // seeded files are not changes
  });

  it('seeds from binary items by their file names', async () => {
    const response = await call({ ...base, command: 'wc -l report.txt && cat report.txt' }, [{ json: {}, binary: { data: inline('one\ntwo\n', 'report.txt') } }]);
    const json = response.outputs[0][0].json as { stdout: string };
    expect(json.stdout).toContain('2 report.txt');
    expect(json.stdout).toContain('one\ntwo');
  });

  it('reports the files a command changed: names, sizes, small contents trimmed', async () => {
    const big = 'x'.repeat(LIMITS.fileContentChars + 500);
    const response = await call({ ...base, command: `echo hello > out.txt; echo '${big}' > big.txt; rm gone.txt; echo more >> keep.txt`, files: JSON.stringify({ 'gone.txt': 'bye', 'keep.txt': 'kept\n' }) });
    const { files } = response.outputs[0][0].json as { files: Array<{ path: string; size: number; change: string; content?: string; contentTruncated?: boolean }> };
    const by = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(by['/home/user/out.txt']).toMatchObject({ change: 'created', size: 6, content: 'hello\n' });
    expect(by['/home/user/big.txt']).toMatchObject({ change: 'created', contentTruncated: true });
    expect(by['/home/user/big.txt'].content).toHaveLength(LIMITS.fileContentChars);
    expect(by['/home/user/gone.txt'].change).toBe('deleted');
    expect(by['/home/user/keep.txt'].change).toBe('modified');
  });

  it('turns a bad file map into a node error, or an error item when continuing on fail', async () => {
    const response = await call({ ...base, command: 'ls', files: '[1,2]' });
    expect(response.error?.message).toMatch(/object of file name/);
  });
});

describe('the host is not reachable', () => {
  const leaks = (text: string) => {
    for (const secret of [CANARY_ENV, CANARY_FILE, homedir(), userInfo().username].filter((s) => s.length > 3 && s !== '/')) {
      expect(text, `leaked ${secret}`).not.toContain(secret);
    }
  };
  const all = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

  it('cat /etc/passwd shows nothing of the host', async () => {
    const r = await runShell({ command: 'cat /etc/passwd' });
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(all(r)).not.toMatch(/root:/);
  });

  it('ls ~ and $HOME are the sandbox home, not the host home', async () => {
    const r = await runShell({ command: 'echo "$HOME"; ls ~; ls -a /; cd ~ && pwd', files: { 'mine.txt': 'x' } });
    expect(r.stdout).toContain('/home/user');
    expect(r.stdout).toContain('mine.txt');
    leaks(all(r));
    expect(r.stdout).not.toMatch(/\b(Users|Library|Desktop|Documents)\b/);
  });

  it('cannot reach the host through absolute paths, .., /proc, /Users or a host temp folder', async () => {
    const cmds = [`cat ${hostDir}/secret.txt`, 'cat /proc/self/environ', 'cat ../../../../../../etc/hosts', `ls ${homedir()}`, 'ls /Users /private /tmp', 'find / -name "*.env" -o -name "*.pem" 2>/dev/null', 'ls -la /proc /dev'];
    for (const command of cmds) {
      const r = await runShell({ command });
      // stderr may echo the path that was asked for; what must not appear is anything read from the host.
      expect(r.stdout, command).not.toContain(CANARY_FILE);
      expect(r.stdout, command).not.toMatch(/root:|localhost\s+127/);
      expect(all(r), command).not.toContain(CANARY_ENV);
    }
    expect((await runShell({ command: `ls ${homedir()}` })).stdout).toBe('');
  });

  it('curl does not exist, and no other command reaches a network', async () => {
    for (const command of ['curl -s http://127.0.0.1:1/', 'curl https://example.com', 'wget http://example.com', 'nc -z 127.0.0.1 22', 'js-exec -c "fetch(\'http://127.0.0.1\')"', 'python3 -c "import socket"']) {
      const r = await runShell({ command });
      expect(r.exitCode, command).toBe(127);
      expect(r.stdout).toBe('');
    }
  });

  it('env, printenv and set hold no host environment and no secret', async () => {
    const r = await runShell({ command: 'env; printenv; set; echo "[$LANDFLOW_AGENT_SHELL_TEST_SECRET][$AWS_SECRET_ACCESS_KEY][$PATH]"; declare -p' });
    leaks(all(r));
    expect(r.stdout).toContain('HOME=/home/user');
    expect(r.stdout).toContain('[][]');
    for (const name of Object.keys(process.env)) {
      if (/^(HOME|PATH|PWD|USER|LOGNAME|OLDPWD|SHELL)$/.test(name)) continue;
      expect(r.stdout, `env name ${name}`).not.toMatch(new RegExp(`^${name.replace(/[^\w]/g, '\\$&')}=`, 'm'));
    }
  });

  it('hostname, whoami, date and uname do not tell the host', async () => {
    const r = await runShell({ command: 'hostname; whoami; date +%Z; uname -a' });
    leaks(all(r));
  });

  it('a file the shell writes is not on the host disk', async () => {
    await runShell({ command: 'echo pwned > /tmp/agent-shell-escape.txt; echo pwned > ~/agent-shell-escape.txt' });
    const { existsSync } = await import('node:fs');
    expect(existsSync('/tmp/agent-shell-escape.txt')).toBe(false);
    expect(existsSync(join(homedir(), 'agent-shell-escape.txt'))).toBe(false);
  });

  it('refuses seed names that climb out', () => {
    expect(() => seedPath('../x')).toThrow(/Bad file name/);
    expect(() => seedPath('a/../../x')).toThrow(/Bad file name/);
    expect(seedPath('/etc/passwd')).toBe('/home/user/etc/passwd');
  });
});

describe('limits', () => {
  it('stops an infinite loop', async () => {
    const t = Date.now();
    const r = await runShell({ command: 'while true; do :; done', timeoutMs: 2000 });
    expect(r.exitCode).not.toBe(0);
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('enforces the time limit on a long sleep', async () => {
    const t = Date.now();
    const r = await runShell({ command: 'sleep 20; echo done', timeoutMs: 1000 });
    expect(Date.now() - t).toBeLessThan(4000);
    expect(r.stdout).not.toContain('done');
    expect(r.exitCode).not.toBe(0);
  });

  it('caps output', async () => {
    const r = await runShell({ command: 'seq 1 9000', maxOutputChars: 1000 });
    expect(r.stdout.length).toBeLessThanOrEqual(1000);
    expect(r.stdoutTruncated).toBe(true);
  });

  it('caps the command length', async () => {
    await expect(runShell({ command: 'echo ' + 'a'.repeat(LIMITS.maxCommandChars) })).rejects.toThrow(/limit is/);
    await expect(runShell({ command: '   ' })).rejects.toThrow(/empty/);
  });

  it('caps seeds and the filesystem size', async () => {
    await expect(runShell({ command: 'ls', files: { big: 'x'.repeat(LIMITS.maxSeedBytes + 1) } })).rejects.toThrow(/limit/);
    const grow = 'x=aaaaaaaaaa; for i in $(seq 1 16); do x="$x$x"; done; for n in 1 2 3 4 5 6; do echo "$x" > f$n; done';
    const cap = 1024 * 1024;
    const outcome = await runShell({ command: grow, maxFsBytes: cap }).then((r) => r, (e: Error) => e);
    // Either the shell refuses the writes (non-zero exit, size within the cap) or the call fails over the cap; never silently over.
    if (outcome instanceof Error) expect(outcome.message).toMatch(/limit/);
    else {
      expect(outcome.fsBytes).toBeLessThanOrEqual(cap);
      expect(outcome.exitCode).not.toBe(0);
    }
  });
});

describe('persistence', () => {
  it('starts every call fresh by default', async () => {
    await runShell({ command: 'echo one > a.txt' });
    const r = await runShell({ command: 'ls' });
    expect(r.stdout).not.toContain('a.txt');
    expect(r.persisted).toBe(false);
    expect(sessionCount()).toBe(0);
  });

  it('keeps files per execution id when asked, and not across executions', async () => {
    const keep = { ...base, options: { keepFiles: true } };
    await call({ ...keep, command: 'echo one > a.txt' }, undefined, 'ex_1');
    const same = await call({ ...keep, command: 'cat a.txt' }, undefined, 'ex_1');
    expect((same.outputs[0][0].json as { stdout: string; persisted: boolean })).toMatchObject({ stdout: 'one\n', persisted: true });
    const other = await call({ ...keep, command: 'cat a.txt' }, undefined, 'ex_2');
    expect((other.outputs[0][0].json as { exitCode: number }).exitCode).not.toBe(0);
  });

  it('drops a kept filesystem that goes over its size cap', async () => {
    await runShell({ command: 'echo hi > a.txt', persistKey: 'k', maxFsBytes: 1024 * 1024 });
    const grow = 'x=aaaaaaaaaa; for i in $(seq 1 16); do x="$x$x"; done; for n in 1 2 3 4 5 6; do echo "$x" > f$n; done';
    const outcome = await runShell({ command: grow, persistKey: 'k', maxFsBytes: 1024 * 1024 }).then((r) => r, (e: Error) => e);
    if (outcome instanceof Error) {
      expect(outcome.message).toMatch(/limit/);
      expect(sessionCount()).toBe(0);
    } else expect(outcome.fsBytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it('keeps at most the session limit', async () => {
    for (let i = 0; i < LIMITS.maxSessions + 5; i++) await runShell({ command: 'echo 1 > x', persistKey: `k${i}` });
    expect(sessionCount()).toBeLessThanOrEqual(LIMITS.maxSessions);
  });
});
