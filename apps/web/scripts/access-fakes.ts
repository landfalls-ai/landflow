/**
 * The GitHub plugin's stateful fake (plugins/github/test/fake-github.ts) served on a port, for the access live check
 * (docs/access-requests.md#trying-it-without-github): the real GitHub plugin points a credential's API Base URL at it, and
 * `GET /_fake/state` shows who is in each team, organization and repository so a person can see a grant land and go.
 *
 *   pnpm --filter @landflow/web exec tsx --tsconfig tsconfig.json scripts/access-fakes.ts 7411
 *
 * Fake logins only (alice, bob, carol, dave, outsider); the token the fake accepts is printed on start.
 */
import { createServer } from 'node:http';
import { FakeGitHub, TOKEN } from '../../../plugins/github/test/fake-github';

const port = Number(process.argv[2] ?? 7411);
const fake = new FakeGitHub();

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://fake');
    if (url.pathname === '/_fake/state') {
      const members = (map: Map<string, unknown>) => Object.fromEntries(map);
      const teams = Object.fromEntries([...fake.access.teams].map(([slug, team]) => [slug, members(team)]));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ teams, orgMembers: members(fake.access.orgMembers), collaborators: members(fake.access.collaborators), orgInvitations: fake.access.orgInvitations, users: members(fake.access.users) }, null, 2));
      return;
    }
    if (url.pathname === '/_fake/reset' && req.method === 'POST') {
      fake.reset();
      res.writeHead(204).end();
      return;
    }
    const raw = Buffer.concat(chunks);
    let body: unknown;
    try {
      body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
    } catch {
      body = undefined;
    }
    const reply = fake.handle({ method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: req.headers, body, raw });
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
    res.end(reply.body === undefined ? '' : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
  });
}).listen(port, '127.0.0.1', () => console.log(`fake GitHub on http://127.0.0.1:${port} (token ${TOKEN}); state at /_fake/state`));
