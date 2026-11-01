'use client';
/**
 * An artifact shown as what it is (lib/shared/artifact-kinds.ts): an image, a PDF, a CSV table as cards, an HTML page in a
 * sandboxed frame. The Artifacts tab opens these inside a card; the detail sheet shows them in place of the raw text.
 * An image or a PDF on another server loads only when tapped, since loading it tells that server who looked.
 */
import { useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { framedHtml, parseCsv, urlHost, type ArtifactShape } from '@/lib/shared/artifact-kinds';
import { Button } from '../ui/button';

/** CSV rows drawn at first; each "Show more" adds 100. */
const ROWS = 25;

function OpenLink({ url, children }: { url: string; children: string }) {
  if (url.startsWith('data:')) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-8 items-center gap-1 self-start text-[12.5px] text-ac underline underline-offset-2">
      {children} <ExternalLink className="size-3 shrink-0" aria-hidden />
    </a>
  );
}

/** Whether to load it yet: inline data at once, another server's file when asked. */
function useAsked(url: string) {
  const [asked, setAsked] = useState(url.startsWith('data:'));
  return [asked, () => setAsked(true)] as const;
}

function ImagePreview({ url, name }: { url: string; name: string }) {
  const [asked, ask] = useAsked(url);
  const [broken, setBroken] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {asked ? (
        broken ? (
          <p className="rounded-xl border border-hair bg-sf2 px-3 py-2 text-[12.5px] text-t3">The image did not load.</p>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- an agent's image from anywhere; next/image would fetch it through the host.
          <img src={url} alt={name} loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="max-h-[60dvh] w-full rounded-xl border border-hair bg-sf2 object-contain" />
        )
      ) : (
        <Button variant="outline" onClick={ask} className="self-start">
          Load the image from {urlHost(url)}
        </Button>
      )}
      <OpenLink url={url}>Open the image</OpenLink>
    </div>
  );
}

function PdfPreview({ url, name }: { url: string; name: string }) {
  const [asked, ask] = useAsked(url);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {asked ? (
        <object data={url} type="application/pdf" aria-label={name} className="h-[70dvh] w-full rounded-xl border border-hair bg-sf2">
          <p className="px-3 py-2 text-[12.5px] text-t3">This browser does not show PDFs inside the page: open it instead.</p>
        </object>
      ) : (
        <Button variant="outline" onClick={ask} className="self-start">
          Show it here (loads from {urlHost(url)})
        </Button>
      )}
      <OpenLink url={url}>Open the PDF</OpenLink>
    </div>
  );
}

/** A table as one card per row, each column a label and its value: a phone has no room for columns side by side. */
function CsvPreview({ text }: { text: string }) {
  const [limit, setLimit] = useState(ROWS);
  const table = useMemo(() => parseCsv(text, limit), [text, limit]);
  const columns = table.header.length;
  if (!table.total && !columns) return <p className="text-[12.5px] text-t3">The table is empty.</p>;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="text-[12px] text-t3">
        {table.total.toLocaleString()} row{table.total === 1 ? '' : 's'} · {columns} column{columns === 1 ? '' : 's'}
      </p>
      <ol className="flex flex-col gap-1.5">
        {table.rows.slice(0, limit).map((row, r) => (
          <li key={r} className="rounded-xl border border-hair bg-sf px-3 py-2">
            <dl className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-0.5 text-[12.5px]">
              {table.header.map((h, c) => (
                <div key={c} className="contents">
                  <dt className="truncate text-t3" title={h}>
                    {h || `Column ${c + 1}`}
                  </dt>
                  <dd className="min-w-0 break-words text-t1">{row[c] ?? ''}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ol>
      {table.total > limit && (
        <button type="button" onClick={() => setLimit(limit + 100)} className="min-h-8 self-start text-[12.5px] text-ac underline underline-offset-2">
          Show {Math.min(100, table.total - limit)} more of {(table.total - limit).toLocaleString()}
        </button>
      )}
    </div>
  );
}

function HtmlPreview({ text, name }: { text: string; name: string }) {
  const [source, setSource] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {source ? (
        <pre className="max-h-[60dvh] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-hair bg-sf px-3 py-2 font-mono text-[12px] text-t1">{text}</pre>
      ) : (
        // A sandbox with no permissions: no script, no forms, no navigation, an origin of its own; the policy in front loads nothing.
        <iframe title={name} sandbox="" srcDoc={framedHtml(text)} referrerPolicy="no-referrer" className="h-[60dvh] w-full rounded-xl border border-hair bg-white" />
      )}
      <button type="button" onClick={() => setSource(!source)} className="min-h-8 self-start text-[12.5px] text-ac underline underline-offset-2">
        {source ? 'Show the page' : 'Show the source'}
      </button>
      {!source && <p className="text-[12px] text-t3">Shown without scripts, images from other servers or working links.</p>}
    </div>
  );
}

/** The shapes shown here; the rest are documents, links, data or text. */
export const PREVIEWED: ArtifactShape[] = ['image', 'pdf', 'csv', 'html'];

/** The artifact as what it is; nothing for a shape this does not preview. `url` must have passed `safeUrl`. */
export function ArtifactPreview({ shape, name, url, text }: { shape: ArtifactShape; name: string; url?: string; text?: string }) {
  if (shape === 'image' && url) return <ImagePreview url={url} name={name} />;
  if (shape === 'pdf' && url) return <PdfPreview url={url} name={name} />;
  if (shape === 'csv' && text !== undefined) return <CsvPreview text={text} />;
  if (shape === 'html' && text !== undefined) return <HtmlPreview text={text} name={name} />;
  return null;
}
