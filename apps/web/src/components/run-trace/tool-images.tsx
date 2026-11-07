'use client';
/**
 * The images a tool returned (a screenshot), in a tool span's detail: a thumbnail from the stored reference, a tap to
 * enlarge, and a plain "expired" card once the file was swept. Only references live in the journal; the bytes are read
 * from the binary route when the picture is shown.
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ImageOff, X } from 'lucide-react';
import { binaryUrl } from '@/lib/client/binary';

export interface TraceImage {
  mimeType: string;
  size: number;
  ref?: string;
}

/** The images in a tool's output: `{ text, images: [{ mimeType, size, ref? }] }` (what the journal keeps), else none. */
export function imagesOf(output: unknown): TraceImage[] {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return [];
  const images = (output as { images?: unknown }).images;
  if (!Array.isArray(images)) return [];
  return images.filter((i): i is TraceImage => Boolean(i) && typeof i === 'object' && typeof (i as TraceImage).mimeType === 'string' && /^image\//.test((i as TraceImage).mimeType));
}

/** "[image: image/png, 74 KB]", the label the chat panel and the transcript use. */
export function imageLabel(image: TraceImage): string {
  const size = image.size >= 1024 * 1024 ? `${(image.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(image.size / 1024))} KB`;
  return `[image: ${image.mimeType}, ${size}]`;
}

/** The output without the images list (the text a tool gave), so the rest shows as before. */
export function withoutImages(output: unknown): unknown {
  if (!imagesOf(output).length) return output;
  const { text, images: _images, ...rest } = output as { text?: unknown; images?: unknown };
  return Object.keys(rest).length ? { ...(text !== undefined && { text }), ...rest } : text;
}

const urlOf = (image: TraceImage) => (image.ref ? `/api/binary/${encodeURIComponent(image.ref)}` : undefined);

function Picture({ image, onOpen }: { image: TraceImage; onOpen: () => void }) {
  const [gone, setGone] = useState(false);
  const url = urlOf(image);
  const label = imageLabel(image);
  if (!url || gone)
    return (
      <div className="flex min-h-24 w-full max-w-72 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-hair bg-sf2 px-3 py-4 text-center text-[12px] text-t3" data-testid="tool-image-expired">
        <ImageOff className="size-5" aria-hidden />
        <span className="font-medium text-t2">Image expired</span>
        <span>The file was deleted after its retention time.</span>
        <span className="font-mono text-[11px]">{label}</span>
      </div>
    );
  return (
    <figure className="m-0 flex w-full max-w-72 flex-col gap-1">
      <button type="button" onClick={onOpen} aria-label={`Enlarge ${label}`} className="block w-full overflow-hidden rounded-xl border border-hair bg-sf2 focus-visible:outline-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- a stored file by reference, not a static asset */}
        <img src={url} alt={label} onError={() => setGone(true)} className="block h-auto max-h-56 w-full object-contain" />
      </button>
      <figcaption className="font-mono text-[11px] text-t3">{label}</figcaption>
    </figure>
  );
}

export function ToolImages({ images }: { images: TraceImage[] }) {
  const [big, setBig] = useState<TraceImage>();
  if (!images.length) return null;
  const url = big && urlOf(big);
  return (
    <section className="min-w-0" aria-label="Images the tool returned">
      <div className="min-h-7 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Images · {images.length}</div>
      <div className="mt-1 flex flex-wrap gap-2">
        {images.map((image, i) => (
          <Picture key={image.ref ?? i} image={image} onOpen={() => setBig(image)} />
        ))}
      </div>
      {big && url && typeof document !== 'undefined' && createPortal(
        <div role="dialog" aria-modal="true" aria-label="Image" className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-3" onClick={() => setBig(undefined)}>
          <button type="button" onClick={() => setBig(undefined)} aria-label="Close" className="absolute right-3 top-3 grid size-11 place-items-center rounded-full bg-black/60 text-white">
            <X className="size-5" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element -- a stored file by reference */}
          <img src={url} alt={imageLabel(big)} className="max-h-full max-w-full object-contain" onClick={(e) => e.stopPropagation()} />
        </div>,
        document.body,
      )}
    </section>
  );
}
