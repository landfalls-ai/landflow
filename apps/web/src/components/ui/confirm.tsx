'use client';
/**
 * "Are you sure?" before a step that can't be taken back (docs/mobile.md#sheets-and-dialogs). On a desktop it is the
 * browser's own confirm, as before; on a phone, where that box is small and out of the app's look, it is a sheet with
 * the question and two 44 px buttons. `confirmAction` resolves true only when the person picks the action.
 */
import { create } from 'zustand';
import { isPhone } from '@/lib/client/use-phone';
import { Button } from './button';
import { Sheet } from './sheet';

interface Ask {
  message: string;
  action: string;
  danger: boolean;
  resolve: (yes: boolean) => void;
}

const useConfirm = create<{ ask?: Ask }>(() => ({}));

export function confirmAction(message: string, { action = 'Continue', danger = false }: { action?: string; danger?: boolean } = {}): Promise<boolean> {
  if (!isPhone()) return Promise.resolve(window.confirm(message));
  // A question still open is answered "no": only one asks at a time.
  useConfirm.getState().ask?.resolve(false);
  return new Promise((resolve) => useConfirm.setState({ ask: { message, action, danger, resolve } }));
}

/** The question asked on a phone, if one is open; `answerConfirm` closes it. */
export const pendingConfirm = () => useConfirm.getState().ask;
export function answerConfirm(yes: boolean) {
  useConfirm.getState().ask?.resolve(yes);
  useConfirm.setState({ ask: undefined });
}

/** Mounted once in the root layout. */
export function ConfirmHost() {
  const ask = useConfirm((s) => s.ask);
  const answer = answerConfirm;
  return (
    <Sheet
      open={Boolean(ask)}
      onClose={() => answer(false)}
      title="Are you sure?"
      footer={
        <div className="flex gap-2">
          <Button variant="ghost" className="h-11 flex-1" onClick={() => answer(false)}>
            Cancel
          </Button>
          <Button variant={ask?.danger ? 'danger' : 'primary'} className="h-11 flex-1" onClick={() => answer(true)}>
            {ask?.action}
          </Button>
        </div>
      }
    >
      <p className="text-[14px] leading-snug text-t2">{ask?.message}</p>
    </Sheet>
  );
}
