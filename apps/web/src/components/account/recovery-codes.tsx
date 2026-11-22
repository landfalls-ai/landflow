'use client';
/**
 * A new set of recovery codes, shown once: the person copies or downloads them before leaving. Nothing here is stored
 * in the browser; the server keeps only keyed hashes, so these are the only readable copy.
 */
import { useMemo } from 'react';
import { Download, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';

export function RecoveryCodes({ codes, onDone, doneLabel = 'I’ve saved them' }: { codes: string[]; onDone: () => void; doneLabel?: string }) {
  const text = useMemo(() => `Landflow recovery codes\nEach works once. Keep them somewhere safe.\n\n${codes.join('\n')}\n`, [codes]);
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'landflow-recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-3" data-testid="recovery-codes">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-t1">
        <KeyRound className="size-4 text-t3" strokeWidth={1.8} /> Your recovery codes
      </div>
      <p className="text-[12px] leading-relaxed text-t2">If you lose your phone, each of these signs you in once. This is the only time they are shown: copy or download them now.</p>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-[10px] border border-hair bg-sf2 px-3 py-2.5 font-mono text-[13px] text-t1 max-md:grid-cols-1">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton text={codes.join('\n')} label="Copy codes" className="size-9 border border-hair max-md:size-11" />
        <Button variant="outline" size="sm" onClick={download}>
          <Download className="size-3.5" /> Download .txt
        </Button>
        <Button variant="primary" size="sm" className="ml-auto max-md:w-full" onClick={onDone}>
          {doneLabel}
        </Button>
      </div>
    </div>
  );
}
