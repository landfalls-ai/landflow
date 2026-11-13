'use client';
/**
 * A document an agent wrote, formatted: GitHub-flavoured Markdown through react-markdown. Everything an agent produces is
 * untrusted, so raw HTML is dropped (and the tree sanitized on top), links open in a new tab and only when they are
 * http or https, images are not loaded, and a table scrolls sideways inside itself. Loaded on demand (next/dynamic).
 */
import type { ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

const safeUrl = (url: string) => (/^https?:\/\//i.test(url) ? url : '');

const el = (Tag: 'h1' | 'h2' | 'h3' | 'h4', cls: string) => {
  const Heading = ({ children }: { children?: ReactNode }) => <Tag className={cn('break-words font-semibold text-t1', cls)}>{children}</Tag>;
  return Heading;
};

const components: Components = {
  h1: el('h1', 'mt-4 text-[18px] first:mt-0'),
  h2: el('h2', 'mt-4 text-[16px] first:mt-0'),
  h3: el('h3', 'mt-3 text-[14.5px] first:mt-0'),
  h4: el('h4', 'mt-3 text-[13.5px] first:mt-0'),
  p: ({ children }) => <p className="mt-2 break-words first:mt-0">{children}</p>,
  ul: ({ children }) => <ul className="mt-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="mt-2 list-decimal space-y-1 pl-5">{children}</ol>,
  blockquote: ({ children }) => <blockquote className="mt-2 border-l-2 border-bd pl-3 text-t2">{children}</blockquote>,
  hr: () => <hr className="my-3 border-hair" />,
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-ac underline underline-offset-2">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // Not loaded: an agent's image URL would be fetched by whoever opens the page.
  img: ({ alt }) => <span className="text-t3">[image{alt ? `: ${alt}` : ''}]</span>,
  code: ({ className, children }) =>
    className ? (
      <code className={cn('font-mono', className)}>{children}</code>
    ) : (
      <code className="break-words rounded bg-acdim px-1 font-mono text-[0.92em]">{children}</code>
    ),
  pre: ({ children }) => <pre className="mt-2 overflow-x-auto rounded-xl border border-hair bg-sf2 p-3 font-mono text-[12px] leading-[1.55]">{children}</pre>,
  table: ({ children }) => (
    <div className="mt-2 overflow-x-auto rounded-xl border border-hair">
      <table className="w-max min-w-full border-collapse text-[12.5px]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-hair bg-sf2 px-2.5 py-1.5 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border-b border-hair px-2.5 py-1.5 align-top">{children}</td>,
  input: ({ checked }) => <input type="checkbox" checked={checked} disabled readOnly className="mr-1.5 align-middle" />,
};

/** In a chat reply a heading is a bold line, not a document's title. */
const chatHeading = ({ children }: { children?: ReactNode }) => <p className="mt-2 break-words font-semibold text-t1 first:mt-0">{children}</p>;
const chatComponents: Components = { ...components, h1: chatHeading, h2: chatHeading, h3: chatHeading, h4: chatHeading };

/** `chat`: a chat reply (components/ui/chat.tsx): 13 px, headings as bold lines. */
export function Markdown({ text, className, chat }: { text: string; className?: string; chat?: boolean }) {
  return (
    <div className={cn('min-w-0 leading-relaxed text-t1', chat ? 'text-[13px]' : 'text-[13.5px]', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} skipHtml urlTransform={safeUrl} components={chat ? chatComponents : components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default Markdown;
