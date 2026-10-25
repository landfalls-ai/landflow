'use client';
/**
 * DataView's Binary mode: the files items carry (`item.binary`), grouped by item. Each file shows its property
 * name, file name, MIME type and size, links to open and download it, and an inline preview: images, PDFs,
 * audio and video in place; text, JSON, CSV, HTML and SVG as source (the first 64 KB of files up to 1 MB).
 */
import { useEffect, useMemo, useState } from 'react';
import { Download, ExternalLink, Eye, EyeOff, File, FileAudio, FileBraces, FileImage, FileText, FileVideo, LoaderCircle, Paperclip } from 'lucide-react';
import { formatFileSize, type BinaryRef } from '@landflow/protocol';
import { tint } from '@/lib/client/node-style';
import {
  binaryEntriesOf,
  binaryUrl,
  canPreviewText,
  displayName,
  inlineBytes,
  previewKindOf,
  previewText,
  TEXT_PREVIEW_MAX_BYTES,
  type BinaryEntry,
  type PreviewKind,
} from '@/lib/client/binary';
import type { NodeItem } from '@/lib/shared/types';

const KIND_META: Record<PreviewKind | 'json', { icon: typeof File; color: string }> = {
  image: { icon: FileImage, color: 'var(--viz-5)' },
  pdf: { icon: FileText, color: 'var(--viz-2)' },
  audio: { icon: FileAudio, color: 'var(--viz-7)' },
  video: { icon: FileVideo, color: 'var(--viz-1)' },
  text: { icon: FileText, color: 'var(--viz-3)' },
  json: { icon: FileBraces, color: 'var(--viz-2)' },
  none: { icon: File, color: 'var(--t3)' },
};

function kindMeta(ref: BinaryRef, kind: PreviewKind) {
  return ref.fileType === 'json' ? KIND_META.json : KIND_META[kind];
}

/** Source text of a small text-like file: fetched from the binary route (or decoded from an inline ref). */
function TextPreview({ entry }: { entry: BinaryEntry }) {
  const { ref } = entry;
  const url = binaryUrl(ref);
  const [state, setState] = useState<{ text?: string; truncated?: boolean; error?: string }>({});
  useEffect(() => {
    if (ref.data !== undefined) {
      setState(previewText(inlineBytes(ref)));
      return;
    }
    if (!url) return;
    const controller = new AbortController();
    setState({});
    fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? 'This file is no longer stored (its execution was deleted).' : `Could not load the file (HTTP ${response.status}).`);
        setState(previewText(new Uint8Array(await response.arrayBuffer())));
      })
      .catch((error: Error) => {
        if (error.name !== 'AbortError') setState({ error: error.message });
      });
    return () => controller.abort();
  }, [ref, url]);
  if (state.error) return <p className="px-1 text-[12px] text-rd">{state.error}</p>;
  if (state.text === undefined) {
    return (
      <p className="flex items-center gap-1.5 px-1 text-[12px] text-t3">
        <LoaderCircle className="size-3 animate-spin" /> Loading preview…
      </p>
    );
  }
  return (
    <div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md border border-hair bg-sf2 px-2.5 py-2 font-mono text-[11.5px] leading-5 text-t1">{state.text || ' '}</pre>
      {state.truncated && <p className="mt-1 px-1 text-[11px] text-t3">Showing the first 64 KB. Download the file to see all of it.</p>}
    </div>
  );
}

function Preview({ entry, kind }: { entry: BinaryEntry; kind: PreviewKind }) {
  const url = binaryUrl(entry.ref);
  const name = displayName(entry);
  if (!url) return null;
  if (kind === 'image') {
    // eslint-disable-next-line @next/next/no-img-element -- bytes from the host's binary route, not a static asset
    return <img src={url} alt={name} loading="lazy" className="max-h-64 max-w-full rounded-md border border-hair bg-sf2 object-contain" />;
  }
  if (kind === 'pdf') return <iframe src={url} title={name} className="h-80 w-full rounded-md border border-hair bg-sf2" />;
  if (kind === 'audio') return <audio controls preload="metadata" src={url} className="w-full" />;
  if (kind === 'video') return <video controls preload="metadata" src={url} className="max-h-64 max-w-full rounded-md border border-hair bg-sf2" />;
  if (kind === 'text') {
    if (!canPreviewText(entry.ref)) {
      return (
        <p className="px-1 text-[12px] text-t3">
          Too large to preview ({formatFileSize(entry.ref.fileSize)}, over {formatFileSize(TEXT_PREVIEW_MAX_BYTES)}). Download it to view.
        </p>
      );
    }
    return <TextPreview entry={entry} />;
  }
  return null;
}

function IconLink({ href, label, icon: Icon, download }: { href: string; label: string; icon: typeof File; download?: string }) {
  return (
    <a
      href={href}
      title={label}
      aria-label={label}
      {...(download !== undefined ? { download } : { target: '_blank', rel: 'noopener noreferrer' })}
      className="grid size-7 place-items-center rounded-full text-t2 transition-colors hover:bg-acdim hover:text-t1"
    >
      <Icon className="size-3.5" />
    </a>
  );
}

function FileCard({ entry, defaultOpen }: { entry: BinaryEntry; defaultOpen: boolean }) {
  const { ref, property } = entry;
  const kind = previewKindOf(ref);
  const previewable = kind !== 'none' && Boolean(binaryUrl(ref));
  const [open, setOpen] = useState(defaultOpen && previewable);
  const { icon: Icon, color } = kindMeta(ref, kind);
  const name = displayName(entry);
  const view = binaryUrl(ref);
  const download = binaryUrl(ref, { download: true });
  return (
    <div className="rounded-lg border border-hair bg-sf">
      <div className="flex min-w-0 items-center gap-2.5 px-2.5 py-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-md" style={{ background: tint(color, 14), color }}>
          <Icon className="size-4" strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-t1" title={name}>
            {name}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-t3">
            <span className="shrink-0 rounded border border-hair px-1 font-mono text-t2" title={`item.binary.${property}`}>
              {property}
            </span>
            <span className="truncate font-mono">{ref.mimeType || 'application/octet-stream'}</span>
            {Number.isFinite(ref.fileSize) && <span className="shrink-0 font-mono">· {formatFileSize(ref.fileSize)}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center">
          {previewable && (
            <button
              onClick={() => setOpen(!open)}
              title={open ? 'Hide preview' : 'Preview'}
              aria-label={open ? 'Hide preview' : 'Preview'}
              aria-expanded={open}
              className="grid size-7 place-items-center rounded-full text-t2 transition-colors hover:bg-acdim hover:text-t1"
            >
              {open ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          )}
          {view && ref.id && <IconLink href={view} label="Open in a new tab" icon={ExternalLink} />}
          {download && <IconLink href={download} label="Download" icon={Download} download={name} />}
        </div>
      </div>
      {open && (
        <div className="border-t border-hair px-2.5 py-2 animate-in">
          <Preview entry={entry} kind={kind} />
        </div>
      )}
    </div>
  );
}

/** The files of `items`, one group per item that has any. */
export function BinaryMode({ items }: { items: NodeItem[] }) {
  const entries = useMemo(() => binaryEntriesOf(items), [items]);
  const groups = useMemo(() => {
    const byItem = new Map<number, BinaryEntry[]>();
    for (const entry of entries) byItem.set(entry.itemIndex, [...(byItem.get(entry.itemIndex) ?? []), entry]);
    return [...byItem.entries()];
  }, [entries]);
  if (!entries.length) return <div className="px-3 py-4 text-[12px] text-t3">Items have no files.</div>;
  const without = items.length - groups.length;
  return (
    <div className="flex flex-col gap-3 p-3">
      {groups.map(([itemIndex, files], i) => (
        <section key={itemIndex} className="animate-fade-up" style={{ animationDelay: `${Math.min(i, 14) * 22}ms` }} aria-label={`Item ${itemIndex}`}>
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-t3">
            <Paperclip className="size-3" />
            <span className="font-mono">item {itemIndex}</span>
            <span>
              · {files.length} file{files.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            {files.map((entry) => (
              <FileCard key={entry.property} entry={entry} defaultOpen={entries.length === 1 || previewKindOf(entry.ref) === 'image'} />
            ))}
          </div>
        </section>
      ))}
      {without > 0 && (
        <p className="text-[11px] text-t3">
          {without} item{without === 1 ? '' : 's'} without files.
        </p>
      )}
    </div>
  );
}
