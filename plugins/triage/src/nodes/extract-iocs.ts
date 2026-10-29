import { NodeOperationError, defineNode } from '@landflow/sdk';
import type { JsonObject } from '@landflow/sdk';
import { IOC_TYPES, collectText, countIocs, extractIocs, type Ioc, type IocType } from '../lib/ioc';
import { getPath } from '../lib/util';

export const ExtractIocs = defineNode({
  description: {
    name: 'extractIocs',
    displayName: 'Extract IOCs',
    description: 'Find IPs, domains, URLs, e-mails, file hashes and CVE ids in an alert, refanging defanged input first',
    version: 1,
    kind: 'action',
    idempotent: true,
    categories: ['Security', 'Developer Tools'],
    icon: 'file:extract-iocs.svg',
    color: '#f59e0b',
    subtitle: '{{fields}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    usableAsTool: true,
    toolDescription: 'Extract indicators of compromise (IPv4/IPv6, domains, URLs, e-mails, MD5/SHA-1/SHA-256, CVE ids) from the input JSON. Defanged values such as hxxp://evil[.]com are refanged first.',
    properties: [
      {
        name: 'fields',
        displayName: 'Fields',
        type: 'string',
        default: '',
        placeholder: 'alert.title, alert.description, alert.raw',
        description: 'Comma-separated dot paths to search. Empty searches the whole item',
      },
      {
        name: 'types',
        displayName: 'Indicator Types',
        type: 'multiOptions',
        default: [...IOC_TYPES],
        options: [
          { name: 'IPv4', value: 'ipv4' },
          { name: 'IPv6', value: 'ipv6' },
          { name: 'Domain', value: 'domain' },
          { name: 'URL', value: 'url' },
          { name: 'E-mail', value: 'email' },
          { name: 'MD5', value: 'md5' },
          { name: 'SHA-1', value: 'sha1' },
          { name: 'SHA-256', value: 'sha256' },
          { name: 'CVE', value: 'cve' },
        ],
      },
      { name: 'dropPrivate', displayName: 'Drop Private IPs', type: 'boolean', default: false, description: 'Leave out private, loopback, link-local and reserved addresses. They are flagged private: true either way' },
      { name: 'defangValues', displayName: 'Defang Values', type: 'boolean', default: false, description: 'Put the defanged form (hxxp://evil[.]com) in `value` too, so the output is safe to paste into chat. The `defanged` field is always there' },
      { name: 'splitItems', displayName: 'One Item per IOC', type: 'boolean', default: false, description: 'Emit one item per indicator under `ioc`. An item without indicators emits nothing' },
    ],
  },
  async execute(ctx) {
    const out: Array<{ json: JsonObject; pairedItem: { item: number } }> = [];
    for (const [i, item] of ctx.getInputData().entries()) {
      try {
        const fields = ctx.getNodeParameter<string>('fields', i, '').split(',').map((s) => s.trim()).filter(Boolean);
        const text = fields.length ? fields.map((f) => collectText(getPath(item.json, f))).join('\n') : collectText(item.json);
        const types = ctx.getNodeParameter<IocType[] | string>('types', i, [...IOC_TYPES]);
        let iocs: Ioc[] = extractIocs(text, {
          types: Array.isArray(types) ? types : IOC_TYPES.filter((t) => String(types).includes(t)),
          dropPrivate: ctx.getNodeParameter<boolean>('dropPrivate', i, false),
        });
        if (ctx.getNodeParameter<boolean>('defangValues', i, false)) iocs = iocs.map((x) => ({ ...x, value: x.defanged }));
        const iocCounts = countIocs(iocs) as unknown as JsonObject;
        if (ctx.getNodeParameter<boolean>('splitItems', i, false)) {
          for (const ioc of iocs) out.push({ json: { ...item.json, ioc: ioc as unknown as JsonObject, iocCounts }, pairedItem: { item: i } });
        } else {
          out.push({ json: { ...item.json, iocs: iocs as unknown as JsonObject[], iocCounts }, pairedItem: { item: i } });
        }
      } catch (error) {
        if (ctx.continueOnFail()) out.push({ json: { ...item.json, error: (error as Error).message }, pairedItem: { item: i } });
        else throw error instanceof NodeOperationError ? error : new NodeOperationError((error as Error).message, { itemIndex: i });
      }
    }
    return [out];
  },
});
