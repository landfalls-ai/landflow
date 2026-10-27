/** Binary in/out: Render Template can output the text as a file, Regex Extract can read a text file. */
import { describe, expect, it } from 'vitest';
import { runNode, type BinaryDataClient, type JsonObject } from '@landflow/sdk';
import type { BinaryRef, ExecuteRequest } from '@landflow/protocol';
import { RegexExtract } from '../src/nodes/regex-extract';
import { Template } from '../src/nodes/template';
import { plugin } from '../src/main';

const inline = (text: string | Buffer, fileName: string, mimeType: string): BinaryRef => {
  const bytes = Buffer.from(text);
  return { mimeType, fileName, fileSize: bytes.length, data: bytes.toString('base64') };
};

function request(type: string, parameters: JsonObject, items: Array<{ json: JsonObject; binary?: Record<string, BinaryRef> }>): ExecuteRequest {
  return {
    protocol: 'landflow.plugin/v1',
    executionId: 'ex_test',
    workflowId: 'wf_test',
    mode: 'manual',
    node: { id: 'n1', name: 'Node', type: `text-toolkit.${type}`, typeVersion: 1 },
    parameters,
    itemParameters: items.map(() => parameters),
    inputs: [items],
  };
}
const extras = { credentialTypes: plugin.credentialTypes, pluginId: 'text-toolkit' };
const decode = (ref: BinaryRef) => Buffer.from(ref.data!, 'base64').toString('utf8');

describe('Render Template as a file', () => {
  const base = { template: '<h1>Hello [[name]]</h1>', outputField: 'rendered' };

  it('stores the rendered text as a file with the given name and type, next to the JSON field and existing files', async () => {
    const other = inline('keep me', 'other.txt', 'text/plain');
    const response = await runNode(
      new Template(),
      request('template', { ...base, asFile: true, binaryPropertyName: 'page', fileName: 'hello.html', mimeType: 'text/html' }, [{ json: { name: 'Zoë' }, binary: { other } }]),
      extras,
    );
    expect(response.error).toBeUndefined();
    const [item] = response.outputs[0];
    expect(item.json).toEqual({ name: 'Zoë', rendered: '<h1>Hello Zoë</h1>' });
    expect(item.binary?.other).toEqual(other);
    expect(item.binary?.page).toMatchObject({ fileName: 'hello.html', mimeType: 'text/html' });
    expect(decode(item.binary!.page)).toBe('<h1>Hello Zoë</h1>');
    expect(item.binary!.page.fileSize).toBe(Buffer.byteLength('<h1>Hello Zoë</h1>'));
  });

  it('stores big output through the binary client and defaults to data / rendered.txt / text/plain', async () => {
    const stored: Array<{ bytes: number; name?: string; type?: string }> = [];
    const client: BinaryDataClient = {
      read: async () => new Uint8Array(),
      stream: async () => new Blob([]).stream(),
      write: async (data, meta) => {
        const bytes = data instanceof Uint8Array ? data.length : 0;
        stored.push({ bytes, name: meta.fileName, type: meta.mimeType });
        return { id: 'ex_test.file1', mimeType: meta.mimeType ?? 'text/plain', fileName: meta.fileName, fileSize: bytes };
      },
    };
    const response = await runNode(new Template(), request('template', { template: 'x'.repeat(200_000), outputField: 'rendered', asFile: true }, [{ json: {} }]), { ...extras, binary: client });
    const [item] = response.outputs[0];
    expect(item.binary?.data).toMatchObject({ id: 'ex_test.file1', fileName: 'rendered.txt' });
    expect(stored).toEqual([{ bytes: 200_000, name: 'rendered.txt', type: 'text/plain' }]);
  });

  it('adds no file by default', async () => {
    const response = await runNode(new Template(), request('template', base, [{ json: { name: 'Ann' } }]), extras);
    expect(response.outputs[0][0].json).toEqual({ name: 'Ann', rendered: '<h1>Hello Ann</h1>' });
    expect(response.outputs[0][0].binary).toBeUndefined();
  });
});

describe('Regex Extract from a file', () => {
  const params = { pattern: '[\\w.+-]+@[\\w-]+\\.[\\w.]+', flags: 'gi', outputField: 'matches', splitMatches: false };

  it('reads a UTF-8 text file (BOM stripped) from a binary property', async () => {
    const file = inline(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ann@example.com, Bob <bob@example.org>\nnope')]), 'contacts.csv', 'text/csv');
    const response = await runNode(RegexExtract, request('regexExtract', { ...params, source: 'binary', binaryPropertyName: 'contacts' }, [{ json: { text: 'ignored@x.io' }, binary: { contacts: file } }]), extras);
    expect(response.error).toBeUndefined();
    expect(response.outputs[0][0].json.matches).toEqual(['ann@example.com', 'bob@example.org']);
  });

  it('splits matches into items, and still reads the JSON field by default', async () => {
    const split = await runNode(RegexExtract, request('regexExtract', { ...params, source: 'binary', splitMatches: true }, [{ json: {}, binary: { data: inline('a@b.io c@d.io', 'x.txt', 'text/plain') } }]), extras);
    expect(split.outputs[0].map((i) => i.json.matches)).toEqual(['a@b.io', 'c@d.io']);
    const field = await runNode(RegexExtract, request('regexExtract', { ...params, field: 'text' }, [{ json: { text: 'z@y.io' } }]), extras);
    expect(field.outputs[0][0].json.matches).toEqual(['z@y.io']);
  });

  it('fails with the property name when the item has no such file', async () => {
    const response = await runNode(RegexExtract, request('regexExtract', { ...params, source: 'binary', binaryPropertyName: 'missing' }, [{ json: {} }]), extras);
    expect(response.error?.message).toMatch(/no binary file “missing”/);
  });
});
