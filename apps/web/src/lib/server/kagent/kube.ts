/**
 * The little of the Kubernetes API that deploying agents to kagent needs (./deploy.ts): server-side apply, get and delete of
 * namespaced resources, with a bearer token and the cluster's CA. `tlsServerName` checks the API server's certificate
 * against another name than the URL's host, like kubeconfig's `tls-server-name`: a kind cluster's API server is reached as
 * host.docker.internal:<port> from Landflow's pods, and its certificate names localhost.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { HttpError } from '../errors';

export interface KubeConnection {
  server: string;
  token: string;
  /** PEM, one or more certificates. */
  caData?: string;
  tlsServerName?: string;
  insecureSkipTlsVerify?: boolean;
}

export interface KubeObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string>; [key: string]: unknown };
  [key: string]: unknown;
}

export class KubeError extends HttpError {
  static readonly errorName: string = 'KubeError';
  constructor(
    message: string,
    status: number,
  ) {
    super(message, status, { expose: true });
  }
}

/** Who wrote the fields (server-side apply). */
export const FIELD_MANAGER = 'landflow';
const TIMEOUT_MS = 15_000;

/** The kinds Landflow writes, by apiVersion/kind: their plural and whether they are in the core group. */
const PLURALS: Record<string, string> = {
  'v1/Secret': 'secrets',
  'api.kagent.dev/v1alpha3/Agent': 'agents',
  'api.kagent.dev/v1alpha3/AgentTemplate': 'agenttemplates',
  'api.kagent.dev/v1alpha3/ModelConfig': 'modelconfigs',
  'api.kagent.dev/v1alpha3/RemoteMCPServer': 'remotemcpservers',
  'api.kagent.dev/v1alpha3/Harness': 'harnesses',
  'api.kagent.dev/v1alpha3/EgressPolicy': 'egresspolicies',
};

export function resourcePath(apiVersion: string, kind: string, namespace: string, name?: string): string {
  const plural = PLURALS[`${apiVersion}/${kind}`];
  if (!plural) throw new Error(`Landflow doesn’t write ${apiVersion} ${kind}`);
  const base = apiVersion.includes('/') ? `/apis/${apiVersion}` : `/api/${apiVersion}`;
  return `${base}/namespaces/${encodeURIComponent(namespace)}/${plural}${name ? `/${encodeURIComponent(name)}` : ''}`;
}

interface Answer {
  status: number;
  body: unknown;
}

/** One request to the API server; the body is JSON (server-side apply takes JSON as YAML). */
export function kubeRequest(connection: KubeConnection, method: string, path: string, body?: unknown, contentType = 'application/json'): Promise<Answer> {
  const url = new URL(path, connection.server.replace(/\/+$/, '') + '/');
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const secure = url.protocol === 'https:';
  const send = secure ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      url,
      {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${connection.token}`,
          ...(payload && { 'content-type': contentType, 'content-length': String(payload.length) }),
        },
        timeout: TIMEOUT_MS,
        ...(secure && {
          ...(connection.caData?.trim() && { ca: connection.caData }),
          ...(connection.tlsServerName?.trim() && { servername: connection.tlsServerName.trim() }),
          rejectUnauthorized: !connection.insecureSkipTlsVerify,
        }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = text;
          try {
            parsed = text ? JSON.parse(text) : undefined;
          } catch {
            // Not JSON: keep the text for the error.
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`The Kubernetes API at ${url.origin} didn’t answer in ${TIMEOUT_MS / 1000}s`)));
    req.on('error', (error) => reject(new KubeError(`The Kubernetes API at ${url.origin} can’t be reached: ${error.message}`, 0)));
    if (payload) req.write(payload);
    req.end();
  });
}

function failure(answer: Answer, what: string): KubeError {
  const message = typeof answer.body === 'object' && answer.body && 'message' in answer.body ? String((answer.body as { message: unknown }).message) : String(answer.body ?? '').slice(0, 300);
  const hint = answer.status === 401 ? ' (the token was refused)' : answer.status === 403 ? ' (the token may not do this: check its Role)' : '';
  return new KubeError(`${what}: ${answer.status} ${message}${hint}`, answer.status);
}

/** Create or update an object with server-side apply (Landflow owns the fields it sets). */
export async function applyObject(connection: KubeConnection, object: KubeObject): Promise<KubeObject> {
  const namespace = object.metadata.namespace ?? 'default';
  const path = `${resourcePath(object.apiVersion, object.kind, namespace, object.metadata.name)}?fieldManager=${FIELD_MANAGER}&force=true`;
  const answer = await kubeRequest(connection, 'PATCH', path, object, 'application/apply-patch+yaml');
  if (answer.status >= 300) throw failure(answer, `Applying ${object.kind} ${namespace}/${object.metadata.name}`);
  return answer.body as KubeObject;
}

/** An object, or undefined when there is none. */
export async function getObject(connection: KubeConnection, apiVersion: string, kind: string, namespace: string, name: string): Promise<KubeObject | undefined> {
  const answer = await kubeRequest(connection, 'GET', resourcePath(apiVersion, kind, namespace, name));
  if (answer.status === 404) return undefined;
  if (answer.status >= 300) throw failure(answer, `Reading ${kind} ${namespace}/${name}`);
  return answer.body as KubeObject;
}

/** Delete an object; one that is already gone is fine. */
export async function deleteObject(connection: KubeConnection, apiVersion: string, kind: string, namespace: string, name: string): Promise<void> {
  const answer = await kubeRequest(connection, 'DELETE', resourcePath(apiVersion, kind, namespace, name));
  if (answer.status >= 300 && answer.status !== 404) throw failure(answer, `Deleting ${kind} ${namespace}/${name}`);
}

/** The objects of one kind in a namespace (`labelSelector` narrows them). */
export async function listObjects(connection: KubeConnection, apiVersion: string, kind: string, namespace: string, labelSelector?: string): Promise<KubeObject[]> {
  const query = labelSelector ? `?labelSelector=${encodeURIComponent(labelSelector)}` : '';
  const answer = await kubeRequest(connection, 'GET', `${resourcePath(apiVersion, kind, namespace)}${query}`);
  if (answer.status >= 300) throw failure(answer, `Listing ${kind} in ${namespace}`);
  return ((answer.body as { items?: KubeObject[] })?.items ?? []).map((item) => ({ ...item, apiVersion, kind }));
}
