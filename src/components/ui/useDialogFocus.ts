'use client';

import { useEffect, useRef } from 'react';

const dialogs: HTMLElement[] = [];
let originalOverflow = '';

/** Keeps focus and scrolling within the topmost order dialog, including its editor. */
export function useDialogFocus<T extends HTMLElement>(onClose: () => void, active = true) {
  const ref = useRef<T>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    const dialog = ref.current;
    if (!active || !dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialogs.length === 0) { originalOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
    dialogs.push(dialog);
    const topmost = () => dialogs.at(-1) === dialog;
    const controls = () => [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')]
      .filter(node => node.getClientRects().length > 0 && node.tabIndex >= 0);
    const focusFirst = () => (dialog.querySelector<HTMLElement>('[data-dialog-close]') ?? controls()[0] ?? dialog).focus();
    focusFirst();
    const onKey = (event: KeyboardEvent) => {
      if (!topmost() || event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); return; }
      if (event.key !== 'Tab') return;
      const items = controls(), first = items[0], last = items.at(-1);
      if (!first) { event.preventDefault(); dialog.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    const onFocus = (event: FocusEvent) => { if (topmost() && event.target instanceof Node && !dialog.contains(event.target)) focusFirst(); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocus);
      const wasTopmost = topmost();
      const index = dialogs.indexOf(dialog);
      if (index >= 0) dialogs.splice(index, 1);
      if (!dialogs.length) document.body.style.overflow = originalOverflow;
      if (wasTopmost && previous?.isConnected) previous.focus();
    };
  }, [active]);
  return ref;
}
