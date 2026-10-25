/**
 * A small HTTP load balancer for the queue-mode stack (deploy/compose.queue.yml): requests go round robin to the mains
 * in LB_UPSTREAMS; a main that can't be reached is skipped for a few seconds and the request goes to the next one, so
 * webhooks keep working while a main restarts. A browser sticks to the main it first reached (cookie `landflow_main`)
 * while that main is up: debug sessions and sign-in redirects live in one main. Streams responses (the editor's SSE).
 *
 * For the local stack only: in production put your own load balancer in front of the mains (nginx, HAProxy, a cloud
 * load balancer) with health checks on /api/health and sticky sessions.
 *
 *   LB_UPSTREAMS=main-1:3000,main-2:3000 LB_PORT=3000 node lb.mjs
 */
import http from 'node:http';

const upstreams = (process.env.LB_UPSTREAMS ?? 'main-1:3000,main-2:3000')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((name) => {
    const [host, port] = name.split(':');
    return { name, host, port: Number(port || 3000), downUntil: 0 };
  });
const port = Number(process.env.LB_PORT ?? 3000);
/** Request bodies are held so a refused connection can go to the next main. */
const MAX_BODY = 64 * 1024 * 1024;
const DOWN_MS = 5_000;
const STICKY = 'landflow_main';
let turn = 0;

/** The mains to try, in order: the sticky one first (when up), then round robin; mains marked down last. */
function candidates(sticky) {
  const now = Date.now();
  const start = turn++ % upstreams.length;
  const rotated = [...upstreams.slice(start), ...upstreams.slice(0, start)];
  const up = rotated.filter((u) => u.downUntil <= now);
  const preferred = up.find((u) => u.name === sticky);
  const ordered = preferred ? [preferred, ...up.filter((u) => u !== preferred)] : up;
  return [...ordered, ...rotated.filter((u) => u.downUntil > now)];
}

/** Forward to one main. Resolves true once it answered, false when it couldn't be reached (nothing sent yet). */
function forward(upstream, req, res, body, sticky) {
  return new Promise((resolve) => {
    const headers = { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress ?? '', 'x-forwarded-host': req.headers.host ?? '', 'x-forwarded-proto': 'http' };
    delete headers['transfer-encoding'];
    if (body.length || req.headers['content-length'] !== undefined) headers['content-length'] = String(body.length);
    const proxied = http.request({ host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers }, (answer) => {
      const out = { ...answer.headers, 'x-landflow-main': upstream.name };
      if (sticky !== upstream.name) {
        const cookie = `${STICKY}=${upstream.name}; Path=/; HttpOnly; SameSite=Lax`;
        const existing = out['set-cookie'];
        out['set-cookie'] = existing ? [...(Array.isArray(existing) ? existing : [existing]), cookie] : [cookie];
      }
      res.writeHead(answer.statusCode ?? 502, out);
      answer.pipe(res);
      answer.on('error', () => res.destroy());
      resolve(true);
    });
    // The client went away: so does the request to the main (an SSE stream, a long webhook).
    res.on('close', () => proxied.destroy());
    proxied.on('error', (error) => {
      if (res.headersSent) return res.destroy(error);
      upstream.downUntil = Date.now() + DOWN_MS;
      console.warn(`lb: ${upstream.name} unreachable (${error.code ?? error.message}), trying the next main`);
      resolve(false);
    });
    proxied.end(body);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/lb/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ upstreams: upstreams.map((u) => ({ name: u.name, down: u.downUntil > Date.now() })) }));
    return;
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) {
        res.writeHead(413, { 'content-type': 'text/plain' }).end('Request body too large\n');
        return;
      }
      chunks.push(chunk);
    }
  } catch {
    return;
  }
  const body = Buffer.concat(chunks);
  const sticky = new RegExp(`(?:^|;\\s*)${STICKY}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1];
  for (const upstream of candidates(sticky)) {
    if (await forward(upstream, req, res, body, sticky)) return;
  }
  res.writeHead(502, { 'content-type': 'text/plain' }).end('No main is reachable\n');
});

// SSE streams stay open as long as the editor does.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.listen(port, () => console.log(`lb: listening on :${port}, mains ${upstreams.map((u) => u.name).join(', ')}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)).closeAllConnections());
