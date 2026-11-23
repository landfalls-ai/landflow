#!/usr/bin/env node
// A stand-in for `dot-agent-deck`, for the plugin's tests. It records every call (argv, stdin, whether it ran in a pane)
// to $FAKE_DECK_DIR/calls.jsonl, answers `dispatch` with admission or a scripted refusal, and serves `inbox fetch --json`
// from $FAKE_DECK_DIR/inbox.json (taking the messages out, as the real fetch does). Replies mirror the deck's own words
// (dispatch.rs, dispatch_return.rs, inbox_cli.rs at the commit the README names).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_DECK_DIR;
const args = process.argv.slice(2);
const inPane = Boolean(process.env.DOT_AGENT_DECK_PANE_ID);
const stdin = await new Promise((resolve) => {
  if (process.stdin.isTTY) return resolve('');
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
});
if (dir) appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ args, stdin, inPane })}\n`);

const notInPane = 'Error: DOT_AGENT_DECK_PANE_ID environment variable not set.\nThis command should be run from within a dot-agent-deck managed pane.';
if (args[0] === '--version') {
  console.log('dot-agent-deck 0.0.0-fake');
} else if (args[0] === 'dispatch') {
  if (!inPane) {
    console.error(notInPane);
    process.exit(1);
  }
  const refusal = dir && existsSync(join(dir, 'refuse.txt')) ? readFileSync(join(dir, 'refuse.txt'), 'utf8') : '';
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
  console.log('Dispatch request sent to the daemon.');
} else if (args[0] === 'inbox' && args[1] === 'fetch') {
  if (!inPane) {
    console.error(notInPane);
    process.exit(1);
  }
  if (process.env.FAKE_DECK_INBOX_REFUSE) {
    console.error(process.env.FAKE_DECK_INBOX_REFUSE);
    process.exit(1);
  }
  const file = join(dir, 'inbox.json');
  const messages = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  writeFileSync(file, '[]');
  console.log(JSON.stringify({ messages }));
} else {
  console.error(`fake deck: unexpected ${args.join(' ')}`);
  process.exit(2);
}
