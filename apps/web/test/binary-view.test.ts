import { describe, expect, it } from 'vitest';
import type { BinaryRef } from '@landflow/protocol';
import type { NodeItem } from '@/lib/shared/types';
import {
  binaryEntriesOf,
  binaryUrl,
  canPreviewText,
  displayName,
  hasBinary,
  inlineBytes,
  previewKindOf,
  previewText,
  TEXT_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_SHOW_BYTES,
} from '@/lib/client/binary';

const ref = (mimeType: string, extra: Partial<BinaryRef> = {}): BinaryRef => ({ id: 'ex_abc123.k3J9vQ2mT0pX', mimeType, fileSize: 10, ...extra });

describe('binary view helpers', () => {
  it('collects the files of items in order, skipping items and entries without them', () => {
    const items: NodeItem[] = [
      { json: { a: 1 } },
      { json: {}, binary: { data: ref('application/pdf'), thumb: ref('image/png') } },
      { json: {}, binary: { broken: null as unknown as BinaryRef, empty: { mimeType: 'text/plain', fileSize: 0 } } },
      { json: {}, binary: { inline: { mimeType: 'text/plain', fileSize: 2, data: 'aGk=' } } },
    ];
    expect(binaryEntriesOf(items).map((e) => `${e.itemIndex}:${e.property}`)).toEqual(['1:data', '1:thumb', '3:inline']);
    expect(hasBinary(items)).toBe(true);
    expect(hasBinary([{ json: {} }])).toBe(false);
    expect(binaryEntriesOf(undefined)).toEqual([]);
  });

  it('previews media in place and markup as source text', () => {
    expect(previewKindOf(ref('image/png'))).toBe('image');
    expect(previewKindOf(ref('image/svg+xml'))).toBe('text');
    expect(previewKindOf(ref('application/pdf'))).toBe('pdf');
    expect(previewKindOf(ref('audio/mpeg'))).toBe('audio');
    expect(previewKindOf(ref('video/mp4'))).toBe('video');
    expect(previewKindOf(ref('text/html; charset=utf-8'))).toBe('text');
    expect(previewKindOf(ref('text/csv'))).toBe('text');
    expect(previewKindOf(ref('application/json'))).toBe('text');
    expect(previewKindOf(ref('application/zip'))).toBe('none');
    // A stated fileType wins over the MIME type.
    expect(previewKindOf(ref('application/octet-stream', { fileType: 'image' }))).toBe('image');
  });

  it('fetches text previews only for small files', () => {
    expect(canPreviewText(ref('text/plain', { fileSize: TEXT_PREVIEW_MAX_BYTES }))).toBe(true);
    expect(canPreviewText(ref('text/plain', { fileSize: TEXT_PREVIEW_MAX_BYTES + 1 }))).toBe(false);
    expect(canPreviewText(ref('image/png'))).toBe(false);
    expect(canPreviewText({ mimeType: 'text/plain', fileSize: TEXT_PREVIEW_MAX_BYTES * 2, data: '' })).toBe(true);
  });

  it('links stored refs to the binary route and inline refs to data: URLs', () => {
    expect(binaryUrl(ref('text/plain'))).toBe('/api/binary/ex_abc123.k3J9vQ2mT0pX');
    expect(binaryUrl(ref('text/plain'), { download: true })).toBe('/api/binary/ex_abc123.k3J9vQ2mT0pX?download=1');
    expect(binaryUrl({ mimeType: 'text/plain', fileSize: 2, data: 'aGk=' })).toBe('data:text/plain;base64,aGk=');
    expect(binaryUrl({ mimeType: '', fileSize: 0 })).toBeUndefined();
  });

  it('names files by file name, else property and extension', () => {
    expect(displayName({ property: 'data', ref: ref('application/pdf', { fileName: 'invoice.pdf' }) })).toBe('invoice.pdf');
    expect(displayName({ property: 'data', ref: ref('application/pdf', { fileExtension: 'pdf' }) })).toBe('data.pdf');
    expect(displayName({ property: 'data', ref: ref('application/octet-stream') })).toBe('data');
  });

  it('decodes text previews and cuts them at 64 KB', () => {
    expect(previewText(new TextEncoder().encode('héllo'))).toEqual({ text: 'héllo', truncated: false });
    const long = previewText(new Uint8Array(TEXT_PREVIEW_SHOW_BYTES + 10).fill(97));
    expect(long.truncated).toBe(true);
    expect(long.text).toHaveLength(TEXT_PREVIEW_SHOW_BYTES);
    expect(new TextDecoder().decode(inlineBytes({ mimeType: 'text/plain', fileSize: 2, data: 'aGk=' }))).toBe('hi');
  });
});
