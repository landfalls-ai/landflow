'use client';
/**
 * Focus for a dialog (docs/mobile.md#sheets-and-dialogs): while `active`, focus moves into `ref` (its first control, or
 * `initial`), Tab and Shift+Tab wrap inside it, and when it closes the focus goes back to what had it before. Escape
 * calls `onEscape` when given (a dialog that already handles Escape leaves it out). `lockScroll` stops the page under it
 * from scrolling.
 */
import { useEffect, useRef, type RefObject } from 'react';

export const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function useDialogFocus(ref: RefObject<HTMLElement | null>, active: boolean, options: { onEscape?: () => void; lockScroll?: boolean; initial?: RefObject<HTMLElement | null> } = {}) {
  // The latest options, without re-running the effect: an inline callback would move the focus on every render.
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  useEffect(() => {
    if (!active) return;
    const opener = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = latest.current.initial?.current ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    // Leave the focus where it is when it is already inside (an autofocus field).
    if (!el?.contains(document.activeElement)) first?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Only the topmost dialog: one opened from another (a credential from an agent's dialog) takes the keys first.
      const modals = document.querySelectorAll('[aria-modal="true"]');
      if (el && modals.length && modals[modals.length - 1] !== el) return;
      if (e.key === 'Escape' && latest.current.onEscape) {
        e.stopPropagation();
        latest.current.onEscape();
      } else if (e.key === 'Tab' && el) {
        const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((i) => i.offsetParent !== null);
        if (!items.length) return;
        const head = items[0];
        const tail = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === head || !el.contains(document.activeElement))) {
          e.preventDefault();
          tail.focus();
        } else if (!e.shiftKey && (document.activeElement === tail || !el.contains(document.activeElement))) {
          e.preventDefault();
          head.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    const overflow = document.body.style.overflow;
    if (latest.current.lockScroll) document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (latest.current.lockScroll) document.body.style.overflow = overflow;
      // Back to the opener, unless the focus already moved somewhere on purpose.
      if (opener?.isConnected && (!document.activeElement || document.activeElement === document.body || el?.contains(document.activeElement))) opener.focus?.();
    };
  }, [active, ref]);
}
