'use client';
/** Pieces the MCP settings sections share: a copyable snippet and an alert. */
import { CopyButton } from '@/components/ui/copy-button';

export const PLACEHOLDER = '<token>';

export function Snippet({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[12px] font-semibold text-t2">{label}</span>
        <CopyButton text={text} label={`Copy ${label.toLowerCase()}`} className="ml-auto" />
      </div>
      <pre className="overflow-x-auto rounded-[10px] border border-hair bg-wl px-3 py-2.5 font-mono text-[12px] leading-relaxed text-t1">{text}</pre>
    </div>
  );
}

export const Alert = ({ children, tone = 'danger' }: { children: React.ReactNode; tone?: 'danger' | 'warning' }) => (
  <div className={tone === 'danger' ? 'rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd animate-fade-up' : 'flex gap-2 rounded-[10px] border border-warnbd bg-warndim px-3 py-2.5 text-[12px] text-warn'}>{children}</div>
);

