import { useEffect, useState } from 'react';

/**
 * Returns the id of the section at the upper part of the viewport, or null above the first one. The
 * interlude between two sections already counts as the next one, because that is what it leads to.
 * Keep `ids` stable between renders.
 */
export function useActiveSection(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const sections = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (!sections.length) return;

    const update = () => {
      const marker = window.innerHeight * 0.4;
      const started = sections[0].getBoundingClientRect().top <= marker;
      const current = sections.find((section) => section.getBoundingClientRect().bottom > marker);
      setActive(started ? (current ?? sections[sections.length - 1]).id : null);
    };

    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [ids]);

  return active;
}
