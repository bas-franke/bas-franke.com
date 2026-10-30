import { useEffect, useRef, useState } from 'react';

/** The phone menu: it stays open until Escape, a press outside the bar or the page moving, and focus never gets lost with it. */
export function useNavMenu() {
  const [open, setOpen] = useState(false);
  const bar = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const links = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    }

    function onPointerDown({ target }: PointerEvent) {
      if (!bar.current?.contains(target as Node)) setOpen(false);
    }

    // the menu is a shortcut: once the page moves, the visitor has gone on without it
    function onMove() {
      if (links.current?.contains(document.activeElement)) button.current?.focus();
      setOpen(false);
    }

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('scroll', onMove, { passive: true });
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('scroll', onMove);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  return { open, setOpen, bar, button, links };
}
