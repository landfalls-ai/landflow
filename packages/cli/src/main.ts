#!/usr/bin/env node
/** The `landflow` binary: the CLI (index.ts) wired to this process — stdio, the environment, a TTY prompt. */
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { run, type Io } from './index';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Ask on the terminal; a secret answer isn't echoed. */
function prompt(question: string, options: { secret?: boolean } = {}): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stderr.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      if (options.secret) process.stderr.write('\n');
      resolve(answer);
    });
    muted = Boolean(options.secret);
  });
}

const io: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readStdin,
  env: process.env,
  cwd: process.cwd(),
  home: homedir(),
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  prompt,
  fetch: globalThis.fetch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

process.exitCode = await run(process.argv.slice(2), io);
