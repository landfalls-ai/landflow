/**
 * Email Trigger (IMAP): a poll trigger (docs/protocol.md §8) that emits one item per new message in a mailbox, with
 * from / to / subject / text / html / headers and, optionally, the attachments as binary files and the raw RFC 822 source
 * (a `.eml` file, a `raw` string). Search Criteria (IMAP SEARCH text, parsed in imap-search.ts) narrows what is emitted. The poll state is the
 * mailbox's UIDVALIDITY and the highest UID seen: the first poll after publishing only records it, later polls emit
 * what arrived since, oldest first, then mark the messages read, move them, or leave them. With "Listen" set to IDLE
 * the host also keeps a connection open (lib/server/imap-idle.ts) and polls as soon as the server announces new mail.
 */
import { defineCredentialType, defineNode, NodeOperationError, pollIntervalProperty, type IExecuteContext } from '@landflow/sdk';
import type { BinaryRef, JsonObject, NodeItem } from '@landflow/protocol';
import { ImapFlow, type ImapFlowOptions, type SearchObject } from 'imapflow';
import { andSearch, ImapSearchError, parseImapSearch } from './imap-search';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';

/** Messages one poll emits at most; the rest follow on the next poll. */
export const MAX_MESSAGES_PER_POLL = 50;
/** The raw source goes into the item's json (`raw`) up to this size; above it the field says why it is missing. */
export const MAX_RAW_JSON_BYTES = 5 * 1024 * 1024;
/** Messages a manual run (Execute in the editor) shows. */
const MANUAL_MESSAGES = 5;

export interface ImapCredential {
  user?: string;
  password?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  allowUnauthorizedCerts?: boolean;
}

export const imapCredential = defineCredentialType({
  name: 'imap',
  displayName: 'IMAP',
  description: 'An IMAP mailbox: host, port and login. Gmail and Microsoft 365 need an app password.',
  icon: 'lucide:mail',
  documentationUrl: 'https://www.rfc-editor.org/rfc/rfc9051',
  properties: [
    { name: 'user', displayName: 'User', type: 'string', default: '', required: true },
    { name: 'password', displayName: 'Password', type: 'string', default: '', required: true, typeOptions: { password: true } },
    { name: 'host', displayName: 'Host', type: 'string', default: '', required: true, placeholder: 'imap.example.com' },
    { name: 'port', displayName: 'Port', type: 'number', default: 993 },
    { name: 'secure', displayName: 'SSL/TLS', type: 'boolean', default: true, description: 'TLS from the start (port 993). Off: plain, upgraded with STARTTLS when the server offers it' },
    { name: 'allowUnauthorizedCerts', displayName: 'Ignore SSL Issues (Insecure)', type: 'boolean', default: false, description: 'Connect even if the certificate cannot be verified' },
  ],
  async test(data) {
    const client = imapClient(data as ImapCredential);
    try {
      await client.connect();
      const status = await client.status('INBOX', { messages: true });
      return { ok: true, message: `Connected: INBOX has ${(status && status.messages) || 0} message(s)` };
    } catch (error) {
      return { ok: false, message: imapErrorText(error) };
    } finally {
      await closeQuietly(client);
    }
  },
});

/** An ImapFlow client for a credential (not connected). */
export function imapClient(credential: ImapCredential, extra: Partial<ImapFlowOptions> = {}): ImapFlow {
  if (!credential.host) throw new NodeOperationError('The IMAP credential has no host');
  const secure = credential.secure !== false;
  return new ImapFlow({
    host: credential.host,
    port: Number(credential.port) || (secure ? 993 : 143),
    secure,
    auth: { user: String(credential.user ?? ''), pass: String(credential.password ?? '') },
    tls: { rejectUnauthorized: !credential.allowUnauthorizedCerts },
    logger: false,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    ...extra,
  });
}

export async function closeQuietly(client: ImapFlow) {
  try {
    if (client.usable) await client.logout();
    else client.close();
  } catch {
    client.close();
  }
}

/** The server's own words when it has them (`[AUTHENTICATIONFAILED] Invalid credentials`). */
export function imapErrorText(error: unknown): string {
  const e = error as { responseText?: string; message?: string; code?: string };
  return [e.responseText || e.message || String(error), e.code && !String(e.responseText ?? e.message).includes(e.code) ? `(${e.code})` : ''].filter(Boolean).join(' ');
}

const addressText = (value: AddressObject | AddressObject[] | undefined) => (Array.isArray(value) ? value.map((v) => v.text).join(', ') : (value?.text ?? ''));
const addressList = (value: AddressObject | AddressObject[] | undefined) =>
  (Array.isArray(value) ? value : value ? [value] : []).flatMap((group) => group.value).map((a) => ({ name: a.name ?? '', address: a.address ?? '' }));

function headerValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(headerValue).join(', ');
  if (value && typeof value === 'object') {
    const v = value as { text?: string; value?: unknown; params?: Record<string, string> };
    if (typeof v.text === 'string') return v.text;
    if (typeof v.value === 'string') return [v.value, ...Object.entries(v.params ?? {}).map(([k, p]) => `${k}=${p}`)].join('; ');
    return JSON.stringify(value);
  }
  return String(value ?? '');
}

export interface MessageOptions {
  mailbox: string;
  downloadAttachments: boolean;
  attachmentPrefix: string;
  /** Store the RFC 822 source as a binary `.eml` file (property `rawProperty`). */
  rawEml?: boolean;
  rawProperty?: string;
  /** Put the RFC 822 source in json as `raw`. */
  rawJson?: boolean;
}

/** A parsed message as the trigger's item; attachments are stored as binary files when asked to. */
export async function messageItem(ctx: Pick<IExecuteContext, 'helpers'>, uid: number, parsed: ParsedMail, flags: string[], options: MessageOptions, source?: Uint8Array): Promise<NodeItem> {
  const headers: JsonObject = {};
  for (const [name, value] of parsed.headers) headers[name] = headerValue(value);
  const attachments = parsed.attachments ?? [];
  const binary: Record<string, BinaryRef> = {};
  const listed: JsonObject[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const fileName = attachment.filename || `attachment-${index + 1}`;
    const entry: JsonObject = { fileName, mimeType: attachment.contentType, size: attachment.size, inline: attachment.contentDisposition === 'inline' };
    if (attachment.cid) entry.contentId = attachment.cid;
    if (options.downloadAttachments) {
      const property = `${options.attachmentPrefix}${index}`;
      binary[property] = await ctx.helpers.prepareBinaryData(attachment.content, fileName, attachment.contentType);
      entry.binaryProperty = property;
    }
    listed.push(entry);
  }
  const json: JsonObject = {
    uid,
    mailbox: options.mailbox,
    messageId: parsed.messageId ?? '',
    date: parsed.date ? parsed.date.toISOString() : '',
    subject: parsed.subject ?? '',
    from: addressText(parsed.from),
    to: addressText(parsed.to),
    cc: addressText(parsed.cc),
    replyTo: addressText(parsed.replyTo),
    fromAddresses: addressList(parsed.from),
    toAddresses: addressList(parsed.to),
    text: parsed.text ?? '',
    html: typeof parsed.html === 'string' ? parsed.html : '',
    flags,
    headers,
    attachments: listed,
  };
  if (parsed.inReplyTo) json.inReplyTo = parsed.inReplyTo;
  if (source && options.rawEml) {
    const property = options.rawProperty || 'eml';
    // Held to the same limits as an attachment: prepareBinaryData refuses what the binary store would.
    binary[property] = await ctx.helpers.prepareBinaryData(Buffer.from(source), `message-${uid}.eml`, 'message/rfc822');
    json.rawBinaryProperty = property;
  }
  if (source && options.rawJson) {
    if (source.byteLength <= MAX_RAW_JSON_BYTES) json.raw = Buffer.from(source).toString('utf8');
    else json.rawSkipped = `The message is ${source.byteLength} bytes, over the ${MAX_RAW_JSON_BYTES} byte limit for the raw field; use the .eml binary output`;
  }
  return Object.keys(binary).length ? { json, binary } : { json };
}

interface PollState extends JsonObject {
  uidValidity: string;
  lastUid: number;
}

export const emailReadImapNode = defineNode({
  description: {
    name: 'emailReadImap',
    displayName: 'Email Trigger (IMAP)',
    description: 'Start the workflow when an email arrives in an IMAP mailbox',
    version: 1,
    kind: 'trigger',
    triggerSource: 'poll',
    categories: ['Triggers', 'Communication'],
    icon: 'lucide:mail-open',
    color: '#f97316',
    subtitle: '{{mailbox}}',
    keywords: ['email', 'imap', 'mail', 'inbox', 'idle', 'attachment'],
    documentationUrl: 'https://www.rfc-editor.org/rfc/rfc9051',
    credentials: [{ name: 'imap', required: true }],
    inputs: [],
    outputs: [{ type: 'main' }],
    properties: [
      pollIntervalProperty(60),
      { name: 'mailbox', displayName: 'Mailbox', type: 'string', default: 'INBOX', placeholder: 'INBOX', description: 'The folder to watch' },
      {
        name: 'listen',
        displayName: 'Listen',
        type: 'options',
        default: 'poll',
        noDataExpression: true,
        options: [
          { name: 'Poll', value: 'poll', description: 'Check every poll interval' },
          { name: 'IDLE (Push)', value: 'idle', description: 'Keep a connection open and check as soon as the server announces new mail; the interval stays as a fallback' },
        ],
      },
      {
        name: 'postProcessAction',
        displayName: 'Action',
        type: 'options',
        default: 'read',
        noDataExpression: true,
        description: 'What happens to a message after it started a run',
        options: [
          { name: 'Mark as Read', value: 'read' },
          { name: 'Move to Folder', value: 'move' },
          { name: 'Nothing', value: 'nothing' },
        ],
      },
      { name: 'moveTo', displayName: 'Folder', type: 'string', default: 'Processed', required: true, displayOptions: { show: { postProcessAction: ['move'] } }, description: 'Created when missing' },
      { name: 'downloadAttachments', displayName: 'Download Attachments', type: 'boolean', default: false, description: 'Attach the files to the item as binary data (attachment_0, attachment_1, …)' },
      { name: 'rawEml', displayName: 'Output Raw Email (.eml)', type: 'boolean', default: false, description: 'Attach the whole message (RFC 822 source) as a binary .eml file' },
      { name: 'rawProperty', displayName: 'Raw Email Property', type: 'string', default: 'eml', displayOptions: { show: { rawEml: [true] } }, description: 'Binary property name of the .eml file' },
      { name: 'rawJson', displayName: 'Include Raw Source in JSON', type: 'boolean', default: false, description: 'Add the RFC 822 source as a string field `raw` (messages over 5 MB leave it out)' },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          { name: 'onlyUnseen', displayName: 'Only Unread', type: 'boolean', default: true, description: 'Skip new messages that are already read. Off: read and unread alike, narrowed by the search criteria' },
          {
            name: 'searchCriteria',
            displayName: 'Search Criteria',
            type: 'string',
            default: '',
            placeholder: 'FROM "billing" SINCE 1-Oct-2026 NOT SUBJECT "spam"',
            typeOptions: { rows: 2 },
            description:
              'IMAP SEARCH keys that new messages must also match (ANDed with Only Unread): FROM, TO, CC, BCC, SUBJECT, BODY, TEXT, HEADER <field> <value>, KEYWORD, UNKEYWORD, SINCE/BEFORE/ON and SENTSINCE/SENTBEFORE/SENTON (1-Oct-2026 or 2026-10-01), LARGER/SMALLER (bytes), UID, ANSWERED, FLAGGED, DELETED, DRAFT (and the UN- forms), NOT, OR and parentheses. Quote values with spaces. Messages that do not match are skipped for good',
          },
          { name: 'attachmentPrefix', displayName: 'Attachment Prefix', type: 'string', default: 'attachment_', description: 'Binary property names: <prefix>0, <prefix>1, …' },
        ],
      },
      {
        name: 'notice',
        displayName: 'The first poll after publishing records where the mailbox stands; later polls emit the messages that arrived since, oldest first. A manual run shows the latest few and changes nothing.',
        type: 'notice',
      },
    ],
  },

  async execute(ctx) {
    const credential = ctx.getCredentials('imap') as ImapCredential | undefined;
    if (!credential?.host) throw new NodeOperationError('Select an IMAP credential');
    const mailbox = String(ctx.getNodeParameter('mailbox', 0, 'INBOX') || 'INBOX').trim();
    const action = String(ctx.getNodeParameter('postProcessAction', 0, 'read'));
    const moveTo = String(ctx.getNodeParameter('moveTo', 0, 'Processed') || '').trim();
    const options = ctx.getNodeParameter<JsonObject>('options', 0, {}) ?? {};
    const messageOptions: MessageOptions = {
      mailbox,
      downloadAttachments: ctx.getNodeParameter<boolean>('downloadAttachments', 0, false) === true,
      attachmentPrefix: String(options.attachmentPrefix ?? 'attachment_') || 'attachment_',
      rawEml: ctx.getNodeParameter<boolean>('rawEml', 0, false) === true,
      rawProperty: String(ctx.getNodeParameter('rawProperty', 0, 'eml') || 'eml').trim() || 'eml',
      rawJson: ctx.getNodeParameter<boolean>('rawJson', 0, false) === true,
    };
    const onlyUnseen = options.onlyUnseen !== false;
    const criteriaText = String(options.searchCriteria ?? '').trim();
    let criteria: SearchObject | undefined;
    try {
      if (criteriaText) criteria = parseImapSearch(criteriaText);
    } catch (error) {
      if (error instanceof ImapSearchError) throw new NodeOperationError(error.message, { description: 'Fix the Search Criteria option: it takes IMAP SEARCH keys such as FROM "billing" SINCE 1-Oct-2026 NOT SUBJECT "spam".' });
      throw error;
    }
    /** The user's criteria ANDed with the unread filter and, for polls, the UIDs after the last one seen. */
    const query = (...extra: SearchObject[]): SearchObject => {
      const all = andSearch([...(criteria ? [criteria] : []), ...(onlyUnseen ? [{ seen: false }] : []), ...extra]);
      return Object.keys(all).length ? all : { all: true };
    };
    if (action === 'move' && !moveTo) throw new NodeOperationError('Enter the folder to move processed messages to');

    const client = imapClient(credential);
    try {
      await ctx.span('imap.connect', { 'server.address': credential.host }, () => client.connect());
    } catch (error) {
      await closeQuietly(client);
      throw new NodeOperationError(`Could not connect to ${credential.host}: ${imapErrorText(error)}`, { description: 'Check the host, port, SSL/TLS setting and login of the IMAP credential.' });
    }
    try {
      let lock;
      try {
        lock = await client.getMailboxLock(mailbox);
      } catch (error) {
        throw new NodeOperationError(`Could not open mailbox “${mailbox}”: ${imapErrorText(error)}`);
      }
      try {
        const box = client.mailbox;
        if (!box) throw new NodeOperationError(`Could not open mailbox “${mailbox}”`);
        const uidValidity = String(box.uidValidity);
        const top = Math.max(0, (box.uidNext ?? 1) - 1);
        const state = ctx.getPollState<PollState>();

        if (ctx.mode !== 'poll') {
          // Editor run: the latest few messages, oldest first; flags, folders and the poll state stay as they are.
          const all = (await client.search(query(), { uid: true })) || [];
          return await fetchItems(ctx, client, all.slice(-MANUAL_MESSAGES), messageOptions);
        }
        if (!state || state.uidValidity !== uidValidity) {
          if (state) ctx.logger.warn('the mailbox was recreated (UIDVALIDITY changed): starting from its current end', { mailbox });
          ctx.setPollState({ uidValidity, lastUid: top });
          return [];
        }
        const lastUid = Number(state.lastUid) || 0;
        if (top <= lastUid) return [];
        const found = ((await client.search(query({ uid: `${lastUid + 1}:*` }), { uid: true })) || [])
          .filter((uid) => uid > lastUid)
          .sort((a, b) => a - b);
        const batch = found.slice(0, MAX_MESSAGES_PER_POLL);
        const items = await fetchItems(ctx, client, batch, messageOptions);
        // Everything up to the mailbox's end was searched unless the batch was cut short.
        const newLastUid = found.length > batch.length ? batch[batch.length - 1] : Math.max(top, lastUid);
        if (batch.length) await postProcess(ctx, client, batch, action, moveTo);
        ctx.setPollState({ uidValidity, lastUid: newLastUid });
        if (items.length) ctx.logger.info(`${items.length} new message(s)`, { mailbox });
        ctx.metrics.counter('landflow.imap.messages', { description: 'Messages the Email Trigger (IMAP) emitted' }).add(items.length, { mailbox });
        return items;
      } finally {
        lock.release();
      }
    } finally {
      await closeQuietly(client);
    }
  },
});

async function fetchItems(ctx: IExecuteContext, client: ImapFlow, uids: number[], options: MessageOptions): Promise<NodeItem[]> {
  const items: NodeItem[] = [];
  if (!uids.length) return items;
  // `source` is fetched with BODY.PEEK[]: reading a message does not mark it read.
  for await (const message of client.fetch(uids, { uid: true, flags: true, source: true }, { uid: true })) {
    if (!message.source) continue;
    const parsed = await simpleParser(message.source, { skipImageLinks: true });
    items.push(await messageItem(ctx, message.uid, parsed, [...(message.flags ?? [])], options, message.source));
  }
  return items.sort((a, b) => Number(a.json.uid) - Number(b.json.uid));
}

async function postProcess(ctx: IExecuteContext, client: ImapFlow, uids: number[], action: string, moveTo: string) {
  if (action === 'read') {
    await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
  } else if (action === 'move') {
    let moved = await client.messageMove(uids, moveTo, { uid: true }).catch(() => false as const);
    if (!moved) {
      await client.mailboxCreate(moveTo).catch(() => undefined);
      moved = await client.messageMove(uids, moveTo, { uid: true });
    }
    if (!moved) ctx.logger.warn(`could not move ${uids.length} message(s) to “${moveTo}”`);
  }
}
