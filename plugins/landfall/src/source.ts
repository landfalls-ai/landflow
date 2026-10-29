/**
 * A minimal Landfall Source Protocol v1 face. Landfall accepts remote triggers (POST /triggers) only from a
 * remote-source connection whose last health check passed; that check calls GET /v1/health and GET /v1/capabilities on
 * the connection's URL. This answers both in the shapes of Landfall's HealthResponse and CapabilitiesResponse schemas
 * (libs/signals/src/protocol/schema.ts) and advertises no read kinds and no operations, so Landfall can only receive
 * from Landflow, never query it. Every other path, including /v1/invoke and /v1/metrics/*, answers 404.
 */
import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export const SOURCE_NAME = 'landflow';
export const PROTOCOL_VERSION = '1';

export interface SourceFaceOptions {
  /** 0 picks a free port. */
  port: number;
  host?: string;
  /** When set, every request must carry `Authorization: Bearer <token>` (Landfall sends the connection's bearer token). */
  token?: string;
}

export interface SourceFace {
  port: number;
  server: Server;
  close(): Promise<void>;
}

function bearerMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer (.+)$/i.exec(header ?? '');
  if (!match) return false;
  const given = Buffer.from(match[1]);
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

export async function startSourceFace(options: SourceFaceOptions): Promise<SourceFace> {
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    req.resume();
    const path = new URL(req.url ?? '/', 'http://source').pathname;
    if (options.token && !bearerMatches(req.headers.authorization, options.token)) return send(401, { error: 'unauthorized' });
    if (req.method === 'GET' && path === '/v1/health') return send(200, { ok: true, detail: 'Landflow Landfall plugin' });
    if (req.method === 'GET' && path === '/v1/capabilities') return send(200, { protocolVersion: PROTOCOL_VERSION, source: SOURCE_NAME, kinds: [], operations: [] });
    return send(404, { error: 'not found' });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '127.0.0.1', resolve);
  });
  return { port: (server.address() as AddressInfo).port, server, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** Start the face from the environment: LANDFALL_SOURCE_PORT (unset: no face), LANDFALL_SOURCE_HOST, LANDFALL_SOURCE_TOKEN. */
export async function startSourceFaceFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<SourceFace | undefined> {
  const raw = env.LANDFALL_SOURCE_PORT?.trim();
  if (!raw) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`LANDFALL_SOURCE_PORT must be a port number, got "${raw}"`);
  return startSourceFace({
    port,
    host: env.LANDFALL_SOURCE_HOST ?? (env.LANDFLOW_ADVERTISE_HOST ? '0.0.0.0' : '127.0.0.1'),
    ...(env.LANDFALL_SOURCE_TOKEN && { token: env.LANDFALL_SOURCE_TOKEN }),
  });
}
