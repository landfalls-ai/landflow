import { describe, expect, it } from 'vitest';
import { countIocs, defang, extractIocs, refang } from '../src/lib/ioc';
import { ExtractIocs } from '../src/nodes/extract-iocs';
import { jsonOf, run } from './helpers';

const values = (text: string, type: string, options = {}) => extractIocs(text, options).filter((i) => i.type === type).map((i) => i.value);

describe('refang', () => {
  it('undoes the usual defanging', () => {
    expect(refang('hxxps://evil[.]com/a[:]b')).toBe('https://evil.com/a:b');
    expect(refang('1(.)2(.)3[.]4')).toBe('1.2.3.4');
    expect(refang('joe[at]evil[.]org')).toBe('joe@evil.org');
    expect(refang('hxxp[:]//a[.]b')).toBe('http://a.b');
  });
});

describe('extractIocs', () => {
  it('finds defanged indicators', () => {
    const iocs = extractIocs('C2 at hxxps://evil[.]example[.]com/gate.php and 8.8.8[.]8, mail joe[at]phish[.]example');
    expect(iocs.map((i) => [i.type, i.value])).toEqual(
      expect.arrayContaining([['url', 'https://evil.example.com/gate.php'], ['ipv4', '8.8.8.8'], ['email', 'joe@phish.example']]),
    );
  });

  it('does not take file names for domains', () => {
    const text = 'See report.pdf, index.html, main.py, run.sh, README.md, archive.zip, app.js, config.json, notes.txt, v1.2.3, main.rs and package.json';
    expect(values(text, 'domain')).toEqual([]);
  });

  it('keeps real domains, including ones with an ambiguous TLD inside a URL, and lower-cases them', () => {
    expect(values('visit Example.COM and sub.evil.co.uk', 'domain')).toEqual(['example.com', 'sub.evil.co.uk']);
    const iocs = extractIocs('get https://dl.example.sh/install and readme.sh');
    expect(iocs.filter((i) => i.type === 'domain').map((i) => i.value)).toEqual(['dl.example.sh']);
  });

  it('flags private, loopback and reserved IPv4, and can drop them', () => {
    const text = 'src 10.1.2.3 dst 8.8.4.4 lo 127.0.0.1 lan 192.168.0.9 cgnat 100.64.1.1 link 169.254.1.1 doc 203.0.113.9 bad 999.1.1.1 ver 1.2.3.4.5';
    const all = extractIocs(text).filter((i) => i.type === 'ipv4');
    expect(Object.fromEntries(all.map((i) => [i.value, i.private]))).toEqual({
      '10.1.2.3': true, '8.8.4.4': false, '127.0.0.1': true, '192.168.0.9': true, '100.64.1.1': true, '169.254.1.1': true, '203.0.113.9': true,
    });
    expect(values(text, 'ipv4', { dropPrivate: true })).toEqual(['8.8.4.4']);
  });

  it('finds IPv6 and ignores times and MAC addresses', () => {
    const text = 'a 2606:4700:4700::1111 b ::1 c fe80::1ff:fe23:4567:890a d fd00::5 at 12:30:45 mac aa:bb:cc:dd:ee:ff tail 2001:4860:4860::8888.';
    const iocs = extractIocs(text).filter((i) => i.type === 'ipv6');
    expect(Object.fromEntries(iocs.map((i) => [i.value, i.private]))).toEqual({
      '2606:4700:4700::1111': false, '::1': true, 'fe80::1ff:fe23:4567:890a': true, 'fd00::5': true, '2001:4860:4860::8888': false,
    });
  });

  it('finds URLs without trailing punctuation, e-mails, hashes and CVEs', () => {
    const md5 = 'd41d8cd98f00b204e9800998ecf8427e';
    const sha1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
    const sha256 = 'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855';
    const text = `See (https://a.example.com/x?y=1). mail Bob.Smith@Corp.example. ${md5} ${sha1} ${sha256} cve-2024-3094 and CVE-2021-44228, ${'a'.repeat(64)}`;
    const iocs = extractIocs(text);
    expect(values(text, 'url')).toEqual(['https://a.example.com/x?y=1']);
    expect(values(text, 'email')).toEqual(['bob.smith@corp.example']);
    expect(values(text, 'md5')).toEqual([md5]);
    expect(values(text, 'sha1')).toEqual([sha1]);
    expect(values(text, 'sha256')).toEqual([sha256.toLowerCase()]);
    expect(values(text, 'cve')).toEqual(['CVE-2024-3094', 'CVE-2021-44228']);
    expect(iocs.filter((i) => i.type === 'domain').map((i) => i.value)).toEqual(expect.arrayContaining(['a.example.com', 'corp.example']));
  });

  it('dedupes and defangs', () => {
    const iocs = extractIocs('1.2.3.4 1.2.3.4 hxxp://x.example.com/a x.example.com');
    expect(iocs.filter((i) => i.type === 'ipv4')).toHaveLength(1);
    expect(iocs.filter((i) => i.type === 'domain')).toHaveLength(1);
    expect(defang('url', 'http://evil.example.com/a.b')).toBe('hxxp://evil[.]example[.]com/a.b');
    expect(defang('ipv4', '1.2.3.4')).toBe('1[.]2[.]3[.]4');
    expect(defang('email', 'a@b.example')).toBe('a[@]b[.]example');
    expect(countIocs(iocs)).toMatchObject({ ipv4: 1, url: 1, domain: 1, md5: 0 });
  });
});

describe('Extract IOCs node', () => {
  const item = { alert: { title: 'Beacon to evil.example.com', description: 'host 10.0.0.5 talks to 45.33.32.156', raw: { note: 'hxxp://bad[.]example.net/p' } }, other: 'ignore 9.9.9.9' };

  it('searches chosen fields and adds iocs and iocCounts', async () => {
    const response = await run(ExtractIocs, { fields: 'alert.title, alert.description' }, [item]);
    const [out] = jsonOf(response);
    expect(out.alert.title).toBe('Beacon to evil.example.com');
    expect(out.iocs.map((i: any) => i.value).sort()).toEqual(['10.0.0.5', '45.33.32.156', 'evil.example.com']);
    expect(out.iocs.find((i: any) => i.value === '10.0.0.5')).toMatchObject({ type: 'ipv4', private: true, defanged: '10[.]0[.]0[.]5' });
    expect(out.iocCounts).toMatchObject({ ipv4: 2, domain: 1, url: 0 });
  });

  it('searches the whole item with no fields, drops private IPs and defangs values on request', async () => {
    const response = await run(ExtractIocs, { dropPrivate: true, defangValues: true }, [item]);
    const [out] = jsonOf(response);
    const ips = out.iocs.filter((i: any) => i.type === 'ipv4').map((i: any) => i.value);
    expect(ips.sort()).toEqual(['45.33.32.156'.replace(/\./g, '[.]'), '9.9.9.9'.replace(/\./g, '[.]')].sort());
    expect(out.iocs.find((i: any) => i.type === 'url').value).toBe('hxxp://bad[.]example[.]net/p');
  });

  it('can limit types and emit one item per IOC', async () => {
    const response = await run(ExtractIocs, { types: ['ipv4'], splitItems: true }, [item]);
    const out = jsonOf(response);
    expect(out.map((o) => o.ioc.value).sort()).toEqual(['10.0.0.5', '45.33.32.156', '9.9.9.9']);
    expect(out[0].alert.title).toBe('Beacon to evil.example.com');
    expect(out[0].iocs).toBeUndefined();
  });
});
