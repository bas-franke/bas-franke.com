import { useEffect, useRef, useState } from 'react';

/** The phone menu: it stays open until Escape or the page moving, keys stay inside it, and focus never gets lost with it. */
export function useNavMenu() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    }

    // the menu is a shortcut: once the page moves, the visitor has gone on without it
    function onMove() {
      if (sheet.current?.contains(document.activeElement)) button.current?.focus();
      setOpen(false);
    }

    const behind = document.querySelectorAll<HTMLElement>('main, footer');
    behind.forEach((part) => (part.inert = true));
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onMove, { passive: true });
    window.addEventListener('resize', onMove);
    return () => {
      behind.forEach((part) => (part.inert = false));
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onMove);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  return { open, setOpen, button, sheet };
}
