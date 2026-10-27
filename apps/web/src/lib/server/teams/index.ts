/**
 * Microsoft Teams on the host side, as a Bot Framework bot (https://learn.microsoft.com/azure/bot-service/rest-api/bot-framework-rest-connector-authentication):
 *
 * - Incoming: Teams (the Bot Connector) POSTs an Activity to the bot's messaging endpoint with `Authorization: Bearer <JWT>`.
 *   The JWT is validated against the registration's OpenID metadata (`openIdMetadataUrl`, then its `jwks_uri`): RS256 with a key
 *   of the JWKS (by `kid`), the metadata's `issuer`, `aud` = the bot's app id, `exp` / `nbf` with five minutes of leeway, and the
 *   `serviceurl` claim equal to the activity's `serviceUrl` (so a replayed token can't point replies somewhere else).
 * - Outgoing: replies go to the activity's `serviceUrl` with a bot token (client credentials at the Microsoft identity platform,
 *   scope `https://api.botframework.com/.default`), cached until a minute before it expires.
 * - Approval buttons are Adaptive Card `Action.Execute` actions (Universal Actions): a click arrives as an `invoke` activity
 *   named `adaptiveCard/action` and is answered in the HTTP response. Each falls back to an `Action.Submit` with the same
 *   data, whose click arrives as a message activity with the data as its `value`.
 *
 * Every URL comes from the `core.microsoftBotApi` credential (metadata, token endpoint), so a test double works through them.
 */
import { createPublicKey, createVerify, type JsonWebKey } from 'node:crypto';
import type { JsonObject } from '@landflow/protocol';
import { credentials } from '../credentials/vault';
import { singleton } from '../singleton';
import type { ApprovalTarget } from '../slack';

export const TEAMS_CREDENTIAL = 'core.microsoftBotApi';
export const DEFAULT_OPENID_METADATA = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
export const BOT_SCOPE = 'https://api.botframework.com/.default';
/** How long a token may be off the clock (Bot Framework's own allowance). */
const LEEWAY_SECONDS = 300;
const METADATA_TTL_MS = 24 * 3_600_000;
/** Teams messages are limited to about 28 KB; split well before. */
const MAX_TEXT = 8_000;

export interface TeamsCredential {
  appId: string;
  appPassword: string;
  tenantId: string;
  openIdMetadataUrl: string;
  tokenUrl: string;
  scope: string;
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

export function teamsCredential(data: JsonObject | undefined): TeamsCredential {
  const appId = text(data?.appId);
  const appPassword = text(data?.appPassword);
  if (!appId || !appPassword) throw new Error('The Microsoft Bot credential needs the app ID and the client secret');
  const tenantId = text(data?.tenantId) || 'botframework.com';
  return {
    appId,
    appPassword,
    tenantId,
    openIdMetadataUrl: text(data?.openIdMetadataUrl) || DEFAULT_OPENID_METADATA,
    tokenUrl: text(data?.tokenUrl) || `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    scope: text(data?.scope) || BOT_SCOPE,
  };
}

/** The credential behind a saved reference (its fields may read `$secrets`, resolved here). */
export const teamsCredentialFor = async (ref: { id: string; name: string }) => teamsCredential(await credentials.dataWithSecrets(ref, TEAMS_CREDENTIAL));

// ---------------------------------------------------------------------------
// Incoming: JWT validation
// ---------------------------------------------------------------------------

interface Metadata {
  issuer: string;
  jwksUri: string;
  fetchedAt: number;
}
interface Jwks {
  keys: Array<JsonWebKey & { kid?: string }>;
  fetchedAt: number;
}
const caches = singleton('teams-auth-caches', () => ({ metadata: new Map<string, Metadata>(), jwks: new Map<string, Jwks>(), tokens: new Map<string, { token: string; expiresAt: number }>() }));

/** Tests: forget fetched metadata, keys and tokens. */
export function resetTeamsCaches() {
  for (const cache of Object.values(caches)) cache.clear();
}

async function getJson(url: string): Promise<JsonObject> {
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!response.ok) throw new Error(`${new URL(url).origin} answered ${response.status}`);
  return (await response.json()) as JsonObject;
}

async function metadataFor(url: string, now: number): Promise<Metadata> {
  const cached = caches.metadata.get(url);
  if (cached && now - cached.fetchedAt < METADATA_TTL_MS) return cached;
  const body = await getJson(url);
  const issuer = text(body.issuer);
  const jwksUri = text(body.jwks_uri);
  if (!issuer || !jwksUri) throw new Error('The OpenID metadata has no issuer or jwks_uri');
  const metadata = { issuer, jwksUri, fetchedAt: now };
  caches.metadata.set(url, metadata);
  return metadata;
}

/** The signing key for a `kid`; the JWKS is fetched again (at most once a minute) when the kid is new, as keys rotate. */
async function keyFor(jwksUri: string, kid: string, now: number) {
  let jwks = caches.jwks.get(jwksUri);
  const find = () => jwks?.keys.find((key) => key.kid === kid && key.kty === 'RSA');
  if (!jwks || (!find() && now - jwks.fetchedAt > 60_000) || now - jwks.fetchedAt > METADATA_TTL_MS) {
    const body = await getJson(jwksUri);
    jwks = { keys: Array.isArray(body.keys) ? (body.keys as Jwks['keys']) : [], fetchedAt: now };
    caches.jwks.set(jwksUri, jwks);
  }
  return find();
}

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as JsonObject;

export type TokenCheck = { ok: true } | { ok: false; reason: string };

/** Validate the `Authorization` header of an incoming activity (see the file header). */
export async function verifyBotRequest(credential: TeamsCredential, authorization: string | null, serviceUrl: string | undefined, now = Date.now()): Promise<TokenCheck> {
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
  if (!token) return { ok: false, reason: 'Missing bearer token' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'Malformed token' };
  let header: JsonObject;
  let claims: JsonObject;
  try {
    header = decode(parts[0]);
    claims = decode(parts[1]);
  } catch {
    return { ok: false, reason: 'Malformed token' };
  }
  if (header.alg !== 'RS256' || !text(header.kid)) return { ok: false, reason: 'Unsupported token algorithm' };
  let metadata: Metadata;
  let jwk: Awaited<ReturnType<typeof keyFor>>;
  try {
    metadata = await metadataFor(credential.openIdMetadataUrl, now);
    jwk = await keyFor(metadata.jwksUri, text(header.kid), now);
  } catch (error) {
    return { ok: false, reason: `Could not load the signing keys: ${(error as Error).message}` };
  }
  if (!jwk) return { ok: false, reason: 'Unknown signing key' };
  let valid = false;
  try {
    valid = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`).verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  } catch {
    // An unusable key: treated as an invalid signature.
  }
  if (!valid) return { ok: false, reason: 'Invalid token signature' };
  const seconds = now / 1000;
  if (claims.iss !== metadata.issuer) return { ok: false, reason: 'Unexpected token issuer' };
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(credential.appId)) return { ok: false, reason: 'The token is not for this bot' };
  if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_SECONDS < seconds) return { ok: false, reason: 'The token has expired' };
  if (typeof claims.nbf === 'number' && claims.nbf - LEEWAY_SECONDS > seconds) return { ok: false, reason: 'The token is not valid yet' };
  const claimed = text(claims.serviceurl ?? claims.serviceUrl);
  if (!claimed || !serviceUrl || claimed.replace(/\/+$/, '') !== serviceUrl.replace(/\/+$/, '')) return { ok: false, reason: 'The token does not match the activity’s serviceUrl' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Outgoing: the Bot Connector
// ---------------------------------------------------------------------------

/** A bot access token (client credentials), cached until a minute before it expires. */
export async function botToken(credential: TeamsCredential, now = Date.now()): Promise<string> {
  const cacheKey = `${credential.tokenUrl}|${credential.appId}`;
  const cached = caches.tokens.get(cacheKey);
  if (cached && cached.expiresAt - 60_000 > now) return cached.token;
  const response = await fetch(credential.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: credential.appId, client_secret: credential.appPassword, scope: credential.scope }),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  const body = (await response.json().catch(() => ({}))) as JsonObject;
  if (!response.ok || !text(body.access_token)) {
    throw new Error(`The bot token request was refused (${response.status}${text(body.error) ? ` ${text(body.error)}` : ''}): check the app ID and client secret`);
  }
  const expiresIn = Number(body.expires_in) || 3_600;
  caches.tokens.set(cacheKey, { token: text(body.access_token), expiresAt: now + expiresIn * 1000 });
  return text(body.access_token);
}

/** The slice of an Activity this host reads and writes. */
export interface Activity {
  type?: string;
  /** An invoke's name (`adaptiveCard/action` for an Action.Execute click). */
  name?: string;
  id?: string;
  replyToId?: string;
  serviceUrl?: string;
  channelId?: string;
  text?: string;
  value?: JsonObject | string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  recipient?: { id?: string; name?: string };
  conversation?: { id?: string; isGroup?: boolean; tenantId?: string; conversationType?: string };
  entities?: Array<{ type?: string; mentioned?: { id?: string } }>;
}

const conversationPath = (serviceUrl: string, conversationId: string, activityId?: string) =>
  `${serviceUrl.replace(/\/+$/, '')}/v3/conversations/${encodeURIComponent(conversationId)}/activities${activityId ? `/${encodeURIComponent(activityId)}` : ''}`;

async function connector(credential: TeamsCredential, method: 'POST' | 'PUT', url: string, body: JsonObject): Promise<string | undefined> {
  const response = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${await botToken(credential)}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Teams ${method} ${new URL(url).origin} answered ${response.status}`);
  return ((await response.json().catch(() => ({}))) as { id?: string }).id;
}

/** Where a message goes: a conversation on a service URL, and the bot's own identity there. */
export interface Conversation {
  serviceUrl: string;
  conversationId: string;
  bot?: { id?: string; name?: string };
  user?: { id?: string; name?: string };
  /** Reply to this activity (threads in channels). */
  replyToId?: string;
}

export const conversationOf = (activity: Activity): Conversation | undefined =>
  activity.serviceUrl && activity.conversation?.id
    ? { serviceUrl: activity.serviceUrl, conversationId: activity.conversation.id, ...(activity.recipient && { bot: activity.recipient }), ...(activity.from && { user: activity.from }), ...(activity.id && { replyToId: activity.id }) }
    : undefined;

/** Send a message (or an Adaptive Card attachment). Returns the new activity's id. */
export async function sendActivity(credential: TeamsCredential, to: Conversation, message: { text?: string; card?: JsonObject }): Promise<string | undefined> {
  const activity: JsonObject = {
    type: 'message',
    ...(to.bot && { from: to.bot as JsonObject }),
    ...(to.user && { recipient: to.user as JsonObject }),
    conversation: { id: to.conversationId },
    ...(message.text !== undefined && { text: message.text, textFormat: 'markdown' }),
    ...(message.card && { attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: message.card }] }),
  };
  // A reply to an activity goes through its own endpoint.
  return connector(credential, 'POST', conversationPath(to.serviceUrl, to.conversationId, to.replyToId), { ...activity, ...(to.replyToId && { replyToId: to.replyToId }) });
}

export async function sendText(credential: TeamsCredential, to: Conversation, textToSend: string): Promise<void> {
  for (const part of splitText(textToSend)) await sendActivity(credential, to, { text: part });
}

/** Replace a message (the approval card once decided). */
export async function updateActivity(credential: TeamsCredential, to: Conversation, activityId: string, message: { text?: string; card?: JsonObject }): Promise<void> {
  await connector(credential, 'PUT', conversationPath(to.serviceUrl, to.conversationId, activityId), {
    type: 'message',
    id: activityId,
    ...(to.bot && { from: to.bot as JsonObject }),
    conversation: { id: to.conversationId },
    ...(message.text !== undefined && { text: message.text, textFormat: 'markdown' }),
    attachments: message.card ? [{ contentType: 'application/vnd.microsoft.card.adaptive', content: message.card }] : [],
  });
}

export function splitText(value: string): string[] {
  const parts: string[] = [];
  let rest = value.trim() || '(no reply)';
  while (rest.length > MAX_TEXT) {
    const cut = Math.max(rest.lastIndexOf('\n', MAX_TEXT), MAX_TEXT / 2);
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  return [...parts, rest];
}

/** The message text without the bot's own @mention (`<at>Bot</at>`) and HTML the client may add. */
export const plainText = (activity: Activity) =>
  (activity.text ?? '')
    .replace(/<at>.*?<\/at>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();

// ---------------------------------------------------------------------------
// Approval cards (Adaptive Cards)
// ---------------------------------------------------------------------------

/** In an action's data (an Action.Execute's `data`, an Action.Submit's `value`): marks the click as ours; the data also carries what it decides. */
export const APPROVAL_MARK = 'landflowApproval';

const preview = (input: unknown) => {
  const body = JSON.stringify(input ?? {}, null, 2);
  return body.length > 2_500 ? `${body.slice(0, 2_500)}…` : body;
};
const CARD = { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4' } as const;

/** "Approve / Reject" as one card's two Action.Execute buttons, each falling back to an Action.Submit with the same data. */
export function approvalCard(request: { title: string; tool: string; input: unknown; target: ApprovalTarget }): JsonObject {
  const data = (approved: boolean): JsonObject => ({ [APPROVAL_MARK]: true, approved, target: request.target as unknown as JsonObject });
  const button = (title: string, style: string, approved: boolean): JsonObject => ({
    type: 'Action.Execute',
    title,
    style,
    verb: approved ? 'approve' : 'reject',
    data: data(approved),
    fallback: { type: 'Action.Submit', title, style, data: data(approved) },
  });
  return {
    ...CARD,
    body: [
      { type: 'TextBlock', text: request.title, weight: 'Bolder', wrap: true },
      { type: 'TextBlock', text: `The tool **${request.tool}** needs your approval.`, wrap: true },
      { type: 'TextBlock', text: preview(request.input), fontType: 'Monospace', wrap: true, size: 'Small' },
    ],
    actions: [
      button('Approve', 'positive', true),
      button('Reject', 'destructive', false),
    ],
  };
}

/** The same card once decided: the buttons replaced by who decided what. */
export function decidedCard(request: { title: string; tool: string; input: unknown; approved: boolean; by?: string }): JsonObject {
  return {
    ...CARD,
    body: [
      { type: 'TextBlock', text: request.title, weight: 'Bolder', wrap: true },
      { type: 'TextBlock', text: `The tool **${request.tool}**`, wrap: true },
      { type: 'TextBlock', text: preview(request.input), fontType: 'Monospace', wrap: true, size: 'Small' },
      { type: 'TextBlock', text: `${request.approved ? '✅ Approved' : '❌ Rejected'}${request.by ? ` by ${request.by}` : ''}`, isSubtle: true, wrap: true },
    ],
  };
}
