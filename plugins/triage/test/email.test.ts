import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseEmail } from '../src/lib/email';
import { ParseEmail } from '../src/nodes/parse-email';
import { EML } from './fixtures';
import { jsonOf, run } from './helpers';

describe('parseEmail', () => {
  const email = parseEmail(EML);

  it('reads headers, decoding encoded words', () => {
    expect(email.headers.from).toEqual({ name: 'PayPal Support', address: 'support@paypa1-secure.example' });
    expect(email.headers.to).toEqual([{ name: 'Ana Lopez', address: 'ana@corp.example' }, { name: '', address: 'bob@corp.example' }]);
    expect(email.headers.replyTo).toEqual([{ name: '', address: 'collect@freemail.example' }]);
    expect(email.headers.returnPath).toBe('bounce@mailer.evil-news.example');
    expect(email.headers.subject).toBe('Urgent: verify your account – action required');
    expect(email.headers.date).toBe('2026-10-28T08:00:00.000Z');
    expect(email.headers.messageId).toBe('20261028080000.1234@mailer.evil-news.example');
    expect(email.headers.received).toHaveLength(2);
    expect(email.headers.received[0]).toContain('mail.evil-news.example [203.0.113.50]');
    expect(email.fromDomain).toBe('paypa1-secure.example');
    expect(email.replyToMismatch).toBe(true);
    expect(email.returnPathMismatch).toBe(true);
  });

  it('parses SPF, DKIM and DMARC verdicts', () => {
    expect(email.authentication).toMatchObject({ spf: 'fail', dkim: 'none', dmarc: 'fail' });
    expect(email.authentication.raw).toHaveLength(1);
  });

  it('decodes quoted-printable text and base64 HTML', () => {
    expect(email.text).toContain('Verify at https://paypa1-secure.example/verify?id=42&t=abc. Café team.');
    expect(email.html).toContain('<a href="https://paypa1-secure.example/verify?id=42&amp;t=abc">here</a>');
  });

  it('collects URLs from href targets and text, once each', () => {
    expect(email.urls).toEqual(['https://paypa1-secure.example/verify?id=42&t=abc', 'https://track.evil-news.example/p.gif']);
  });

  it('lists the attachment with size and SHA-256', () => {
    const bytes = Buffer.from('%PDF-1.4 fake pdf bytes');
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0]).toMatchObject({ filename: 'invoice.pdf', contentType: 'application/pdf', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  });

  it('survives garbage, truncation and missing boundaries', () => {
    expect(parseEmail('').warnings.length).toBeGreaterThan(0);
    expect(parseEmail('just some words, no headers').text).toBe('');
    const truncated = parseEmail(EML.slice(0, EML.indexOf('--ALT-1--')));
    expect(truncated.headers.subject).toContain('Urgent');
    expect(truncated.text).toContain('Dear customer');
    const noBoundary = parseEmail('Content-Type: multipart/mixed\r\nSubject: x\r\n\r\nbody');
    expect(noBoundary.warnings).toContain('Multipart message without a boundary');
    expect(() => parseEmail(Buffer.from([0xff, 0xfe, 0x00, 0x41]))).not.toThrow();
  });

  it('handles a single-part latin-1 message and an mbox From line', () => {
    const raw = Buffer.concat([Buffer.from('From sender Tue Oct 28 08:00:00 2026\nFrom: a@x.example\nSubject: hi\nContent-Type: text/plain; charset=iso-8859-1\nContent-Transfer-Encoding: 8bit\n\ncaf'), Buffer.from([0xe9]), Buffer.from('\n')]);
    const parsed = parseEmail(raw);
    expect(parsed.headers.subject).toBe('hi');
    expect(parsed.text).toBe('café');
  });
});

describe('Parse Email node', () => {
  it('parses a field and leaves the rest of the item', async () => {
    const response = await run(ParseEmail, {}, [{ email: EML, ticket: 'T-1' }]);
    expect(response.error).toBeUndefined();
    const [out] = jsonOf(response);
    expect(out.ticket).toBe('T-1');
    expect(out.email.headers.subject).toContain('Urgent');
    expect(out.email.attachments[0].content).toBeUndefined();
    expect(response.outputs[0][0].binary).toBeUndefined();
  });

  it('reads a .eml binary property and can emit attachments as binary', async () => {
    const ref = { mimeType: 'message/rfc822', fileName: 'report.eml', fileSize: EML.length, data: Buffer.from(EML).toString('base64') };
    const response = await run(ParseEmail, { source: 'binary', attachmentsAsBinary: true }, [{}], { binary: [{ data: ref }] });
    expect(response.error).toBeUndefined();
    const item = response.outputs[0][0];
    expect((item.json as any).email.headers.from.address).toBe('support@paypa1-secure.example');
    expect(item.binary?.attachment_0).toMatchObject({ fileName: 'invoice.pdf', mimeType: 'application/pdf' });
    expect(Buffer.from(item.binary!.attachment_0.data!, 'base64').toString()).toBe('%PDF-1.4 fake pdf bytes');
    expect(item.binary?.data).toEqual(ref);
  });

  it('errors on a missing field, or turns it into an error item with continueOnFail', async () => {
    expect((await run(ParseEmail, {}, [{}])).error?.message).toContain('holds no e-mail text');
    const response = await run(ParseEmail, {}, [{}], { continueOnFail: true });
    expect(jsonOf(response)[0].error).toContain('holds no e-mail text');
  });
});
