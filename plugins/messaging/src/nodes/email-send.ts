import { defineCredentialType, defineNode, NodeOperationError, type JsonObject, type SpanFunction } from '@landflow/sdk';
import { clientSpan, countApiError, countSent, mapItems, requireString, statusClass, type ApiContext } from '../shared';
import { sendMail, SmtpError, verifySmtp, type MailOptions, type PhaseRunner, type SmtpConfig } from '../smtp';

export interface SmtpCredentials extends JsonObject {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  disableStartTls: boolean;
  hostName: string;
}

export function smtpConfig(credentials: SmtpCredentials, allowUnauthorizedCerts = false): SmtpConfig {
  const host = String(credentials.host ?? '').trim();
  if (!host) throw new NodeOperationError('The SMTP credential has no host');
  const secure = credentials.secure !== false && String(credentials.secure) !== 'false';
  const user = String(credentials.user ?? '').trim();
  return {
    host,
    port: Number(credentials.port) || (secure ? 465 : 587),
    secure,
    ...(user && { user, password: String(credentials.password ?? '') }),
    disableStartTls: credentials.disableStartTls === true,
    ...(String(credentials.hostName ?? '').trim() && { hostName: String(credentials.hostName).trim() }),
    rejectUnauthorized: !allowUnauthorizedCerts,
  };
}

/** What to try next, by failure. */
function hint(error: SmtpError, config: SmtpConfig): string | undefined {
  const code = error.code;
  if (code === 535 || code === 534)
    return 'The server rejected the user name or password. Gmail, Outlook and others need an app password instead of the account password.';
  if (code === 530) return 'The server requires authentication: set User and Password in the credential.';
  if (error.phase === 'RCPT TO') return 'Check the recipient addresses; the server may also refuse to relay for this sender.';
  if (error.phase === 'MAIL FROM') return 'The server refused the sender address. Many servers only accept the authenticated account (or its aliases) as From.';
  if (error.kind === 'tls' && /wrong version number/i.test(error.message)) {
    return 'SSL/TLS is on but the server expects a plain connection: turn SSL/TLS off for port 587 or 25 (STARTTLS is used automatically).';
  }
  if (error.kind === 'tls') return 'The server certificate is not trusted. Enable "Ignore SSL Issues" only for servers you trust.';
  if (error.kind === 'timeout' && error.phase === 'greeting' && !config.secure) return 'No greeting: if this is an implicit-TLS port (465), turn SSL/TLS on.';
  if (error.kind === 'network' && error.phase === 'connect') return `Nothing answered on ${config.host}:${config.port}. Check the host and port.`;
  return undefined;
}

/** Count the failure (status_class from the SMTP reply code) and turn it into a node error with the server's reply. */
function toNodeError(api: ApiContext, error: unknown, config: SmtpConfig): NodeOperationError {
  if (!(error instanceof SmtpError)) {
    if (error instanceof NodeOperationError) return error;
    return new NodeOperationError((error as Error)?.message ?? String(error));
  }
  countApiError(api, 'email', error.code ? statusClass(error.code) : error.kind);
  const description = hint(error, config);
  return new NodeOperationError(error.message, description ? { description } : {});
}

/** `smtp.connect`, `smtp.ehlo`, `smtp.starttls`, `smtp.auth`, `smtp.envelope`, `smtp.data`, `smtp.quit` child spans. */
const phases =
  (span: SpanFunction): PhaseRunner =>
  (phase, fn) =>
    span(`smtp.${phase}`, () => fn());

const spanAttributes = (config: SmtpConfig) => ({ 'server.address': config.host, 'server.port': config.port, 'messaging.system': 'smtp' });

export const smtp = defineCredentialType<SmtpCredentials>({
  name: 'smtp',
  displayName: 'SMTP',
  icon: 'file:email.svg',
  documentationUrl: 'https://www.rfc-editor.org/rfc/rfc5321',
  properties: [
    { name: 'user', displayName: 'User', type: 'string', default: '', description: 'Leave empty for servers that need no login' },
    { name: 'password', displayName: 'Password', type: 'string', default: '', typeOptions: { password: true } },
    { name: 'host', displayName: 'Host', type: 'string', required: true, default: '', placeholder: 'smtp.example.com' },
    { name: 'port', displayName: 'Port', type: 'number', default: 465, description: '465 for SSL/TLS, 587 (or 25) for STARTTLS' },
    {
      name: 'secure',
      displayName: 'SSL/TLS',
      type: 'boolean',
      default: true,
      description: 'Connect with TLS from the start (port 465). Off: a plain connection, upgraded with STARTTLS when the server offers it',
    },
    {
      name: 'disableStartTls',
      displayName: 'Disable STARTTLS',
      type: 'boolean',
      default: false,
      displayOptions: { show: { secure: [false] } },
      description: 'Stay unencrypted even when the server offers STARTTLS (local test servers only)',
    },
    { name: 'hostName', displayName: 'Client Host Name', type: 'string', default: '', description: "Name sent with EHLO (default: this machine's host name)" },
  ],
  async test(data, ctx) {
    let config: SmtpConfig;
    try {
      config = smtpConfig(data);
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    try {
      const session = await clientSpan(ctx, 'smtp.verify', spanAttributes(config), () => verifySmtp({ ...config, timeoutMs: 15_000 }, phases(ctx.span)));
      const security = session.secure ? 'TLS' : 'unencrypted';
      return {
        ok: true,
        message: `Connected to ${config.host}:${config.port} (${security}${session.authMethod ? `, AUTH ${session.authMethod} accepted` : ', no login'})`,
      };
    } catch (error) {
      const message = (error as Error).message;
      const description = error instanceof SmtpError ? hint(error, config) : undefined;
      return { ok: false, message: description ? `${message}. ${description}` : message };
    }
  },
});

export const EmailSend = defineNode({
  description: {
    name: 'emailSend',
    displayName: 'Send Email',
    description: 'Send an email through any SMTP server (text, HTML or both)',
    version: 1,
    kind: 'action',
    categories: ['Communication'],
    icon: 'file:email.svg',
    color: '#6B7280',
    subtitle: '{{toEmail}}',
    documentationUrl: 'https://www.rfc-editor.org/rfc/rfc5321',
    keywords: ['email', 'mail', 'smtp', 'send'],
    usableAsTool: true,
    toolDescription: 'Send an email to one or more comma-separated addresses with a subject and a text and/or HTML body.',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'smtp', required: true }],
    properties: [
      { name: 'fromEmail', displayName: 'From Email', type: 'string', required: true, default: '', placeholder: 'Jane Doe <jane@example.com>' },
      {
        name: 'toEmail',
        displayName: 'To Email',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'info@example.com, John <john@example.com>',
        description: 'Comma-separated recipients, each optionally with a name: Nathan Doe <nate@example.com>',
      },
      { name: 'subject', displayName: 'Subject', type: 'string', default: '', placeholder: 'My subject line' },
      {
        name: 'emailFormat',
        displayName: 'Email Format',
        type: 'options',
        default: 'html',
        options: [
          { name: 'Text', value: 'text', description: 'Plain text only' },
          { name: 'HTML', value: 'html', description: 'HTML only' },
          { name: 'Both', value: 'both', description: 'HTML with a plain-text alternative (multipart/alternative)' },
        ],
      },
      { name: 'text', displayName: 'Text', type: 'string', default: '', typeOptions: { rows: 5 }, displayOptions: { show: { emailFormat: ['text', 'both'] } } },
      { name: 'html', displayName: 'HTML', type: 'string', default: '', typeOptions: { rows: 5 }, displayOptions: { show: { emailFormat: ['html', 'both'] } } },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          { name: 'ccEmail', displayName: 'CC Email', type: 'string', default: '', description: 'Comma-separated' },
          { name: 'bccEmail', displayName: 'BCC Email', type: 'string', default: '', description: 'Comma-separated; not visible to other recipients' },
          { name: 'replyTo', displayName: 'Reply To', type: 'string', default: '', description: 'Where replies go, if not to From' },
          {
            name: 'allowUnauthorizedCerts',
            displayName: 'Ignore SSL Issues (Insecure)',
            type: 'boolean',
            default: false,
            description: 'Accept invalid or self-signed server certificates',
          },
        ],
      },
    ],
  },
  async execute(ctx) {
    const credentials = ctx.getCredentials<SmtpCredentials>('smtp');
    const api: ApiContext = { http: ctx.http, metrics: ctx.metrics };
    return mapItems(ctx, async (i) => {
      const options = ctx.getNodeParameter<JsonObject>('options', i, {}) ?? {};
      const config = smtpConfig(credentials, options.allowUnauthorizedCerts === true);
      const format = ctx.getNodeParameter<string>('emailFormat', i, 'html');
      const mail: MailOptions = {
        from: requireString(ctx, 'fromEmail', 'From Email', i),
        to: String(ctx.getNodeParameter('toEmail', i, '') ?? ''),
        cc: String(options.ccEmail ?? ''),
        bcc: String(options.bccEmail ?? ''),
        replyTo: String(options.replyTo ?? ''),
        subject: String(ctx.getNodeParameter('subject', i, '') ?? ''),
        ...(format !== 'html' && { text: String(ctx.getNodeParameter('text', i, '') ?? '') }),
        ...(format !== 'text' && { html: String(ctx.getNodeParameter('html', i, '') ?? '') }),
      };
      try {
        const result = await clientSpan(ctx, 'smtp.send', spanAttributes(config), async (span) => {
          const sent = await sendMail(config, mail, phases(ctx.span));
          span.setAttribute('smtp.recipients.accepted', sent.accepted.length);
          span.setAttribute('smtp.recipients.rejected', sent.rejected.length);
          return sent;
        });
        countSent(api, 'email', 'send');
        ctx.logger.info('email sent', { 'smtp.recipients.accepted': result.accepted.length, 'smtp.recipients.rejected': result.rejected.length });
        return { messageId: result.messageId, accepted: result.accepted, rejected: result.rejected, response: result.response };
      } catch (error) {
        throw toNodeError(api, error, config);
      }
    });
  },
});
