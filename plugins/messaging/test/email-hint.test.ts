/** The TLS hint of Send Email and the smtp credential test: a plain server (a local mail catcher) versus a bad certificate. */
import { afterEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@landflow/sdk';
import { EmailSend } from '../src/nodes/email-send';
import { selfSignedCertificate } from './cert';
import { startFakeSmtp, type FakeSmtp } from './fake-smtp';
import { run, testCredentials } from './helpers';

let server: FakeSmtp | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const credential = (port: number, extra: JsonObject = {}): JsonObject => ({
  host: '127.0.0.1', port, secure: true, hostName: 'landflow.test', ...extra,
});
const send = (port: number) =>
  run(EmailSend, { fromEmail: 'bot@example.com', toEmail: 'ann@example.com', subject: 'Hi', emailFormat: 'text', text: 'Hello' }, { credentials: { smtp: credential(port) } });

describe('TLS hint', () => {
  it('says to turn SSL/TLS off when a plain server answers, on any port', async () => {
    server = await startFakeSmtp();
    const response = await send(server.port);
    expect(response.error?.description).toMatch(/answers without TLS: turn SSL\/TLS off/);
    expect(response.error?.description).toContain(`127.0.0.1:${server.port}`);
    expect(response.error?.description).toMatch(/Mailpit/);
    const test = await testCredentials('smtp', credential(server.port));
    expect(test.ok).toBe(false);
    expect(test.message).toMatch(/turn SSL\/TLS off.*Mailpit/);
  });

  it('keeps the certificate hint for a self-signed server', async () => {
    server = await startFakeSmtp({ tls: selfSignedCertificate(), implicitTls: true });
    const response = await send(server.port);
    expect(response.error?.description).toMatch(/certificate is not trusted/);
    expect(response.error?.description).not.toMatch(/turn SSL\/TLS off/);
  });
});
