import { useEffect } from 'react';

/**
 * Fades in every element with a `data-reveal` attribute shortly before it scrolls into view, and
 * well past the top too. A block that is already on screen by then got there through a jump or a
 * very fast scroll, and only gets a short fade (`in--now`), so that never lands on an empty screen.
 * Elements are revealed immediately when the visitor prefers reduced motion.
 */
export function useRevealAll() {
  useEffect(() => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !('IntersectionObserver' in window)) {
      elements.forEach((el) => el.classList.add('in'));
      return;
    }
    let loaded = false;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const jumped = loaded && entry.boundingClientRect.top < window.innerHeight;
            entry.target.classList.add('in');
            entry.target.classList.toggle('in--now', jumped);
            observer.unobserve(entry.target);
          }
        }
        loaded = true;
      },
      { rootMargin: '200% 0px 30% 0px' },
    );
    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);
}
