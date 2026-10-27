import { useEffect, type RefObject } from 'react';

/**
 * Touch paging for the feed. Native mandatory scroll snap moves to the next story on the slightest flick, and its
 * momentum flies past the end of a story taller than the screen. Here the finger drives the scroll 1:1, momentum
 * stops at the edge of the story being read, and only a deliberate pull past that edge changes story.
 * Mouse and trackpad readers keep native scrolling (see `.feed` in styles.css).
 */

const ITEMS = '.story, .feed-end';
const RESIST = 0.55; // past a story's edge the page follows the finger at this rate
const PULL = 0.25; // a pull of this fraction of the screen past the edge changes story...
const FLICK_PULL = 90; // ...or a flick that pulled at least this far (px)...
const FLICK_SPEED = 0.7; // ...at this speed (px/ms)
const SLOP = 8; // px before a touch counts as a drag
const FRICTION = 0.997; // momentum keeps this share of its speed per ms (iOS-like; glides ~330ms worth of speed)
const MIN_SPEED = 0.02; // px/ms below which momentum stops
const HOLD = 60; // ms without movement before lift-off that cancels momentum

type Item = { top: number; end: number }; // `end` is the furthest scrollTop that still shows only this item

export function useSwipePager(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    const root = ref.current;
    if (!root || !enabled || !matchMedia('(hover: none) and (pointer: coarse)').matches) return;
    root.classList.add('feed-paged');

    let anim = 0;
    let gesture: {
      x: number;
      y: number;
      scroll: number;
      items: Item[];
      index: number;
      axis?: 'x' | 'y';
      samples: { t: number; y: number }[];
    } | null = null;
    let suppressClick = false;

    const stop = () => {
      cancelAnimationFrame(anim);
      anim = 0;
    };

    const animateTo = (target: number, duration: number) => {
      stop();
      const from = root.scrollTop;
      const max = root.scrollHeight - root.clientHeight;
      const to = Math.max(0, Math.min(max, target));
      if (Math.abs(to - from) < 1) return;
      const start = performance.now();
      const step = (now: number) => {
        const p = Math.min(1, (now - start) / duration);
        root.scrollTop = from + (to - from) * (1 - (1 - p) ** 3);
        anim = p < 1 ? requestAnimationFrame(step) : 0;
      };
      anim = requestAnimationFrame(step);
    };

    // Native-feeling momentum: start at the finger's speed and decay smoothly, stopping at the story's edges.
    const glide = (velocity: number, min: number, max: number) => {
      stop();
      let v = velocity;
      let pos = root.scrollTop;
      let last = performance.now();
      const step = (now: number) => {
        const dt = Math.min(40, now - last);
        last = now;
        const decay = FRICTION ** dt;
        // Exact integral of v·FRICTION^t over this frame, so the distance doesn't depend on the frame rate.
        pos += (v * (decay - 1)) / Math.log(FRICTION);
        v *= decay;
        const clamped = Math.max(min, Math.min(max, pos));
        root.scrollTop = clamped;
        anim = clamped === pos && Math.abs(v) > MIN_SPEED ? requestAnimationFrame(step) : 0;
      };
      anim = requestAnimationFrame(step);
    };

    const measure = (): Item[] => {
      const base = root.getBoundingClientRect().top - root.scrollTop;
      const view = root.clientHeight;
      return [...root.querySelectorAll<HTMLElement>(ITEMS)].map((el) => {
        const r = el.getBoundingClientRect();
        const top = r.top - base;
        return { top, end: top + Math.max(0, r.height - view) };
      });
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        gesture = null;
        return;
      }
      stop();
      const items = measure();
      const scroll = root.scrollTop;
      let index = 0;
      items.forEach((it, i) => {
        if (it.top <= scroll + 2) index = i;
      });
      const t = e.touches[0];
      gesture = { x: t.clientX, y: t.clientY, scroll, items, index, samples: [{ t: e.timeStamp, y: t.clientY }] };
      suppressClick = false;
    };

    const onMove = (e: TouchEvent) => {
      if (!gesture) return;
      if (e.touches.length !== 1) {
        gesture = null;
        return;
      }
      const t = e.touches[0];
      const dx = t.clientX - gesture.x;
      const dy = t.clientY - gesture.y;
      if (!gesture.axis) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        gesture.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        suppressClick = true;
      }
      if (gesture.axis === 'x') return;
      e.preventDefault();

      const { top, end } = gesture.items[gesture.index] ?? { top: 0, end: 0 };
      let next = gesture.scroll - dy;
      if (next > end) next = end + (next - end) * RESIST;
      else if (next < top) next = top - (top - next) * RESIST;
      root.scrollTop = next;

      gesture.samples.push({ t: e.timeStamp, y: t.clientY });
      while (gesture.samples.length > 2 && e.timeStamp - gesture.samples[0].t > 100) gesture.samples.shift();
    };

    const onEnd = (e: TouchEvent) => {
      const g = gesture;
      gesture = null;
      if (!g || g.axis !== 'y') return;

      const first = g.samples[0];
      const last = g.samples[g.samples.length - 1];
      const dt = last.t - first.t;
      // Positive = finger moving up = reading further down. A finger that came to rest before lifting doesn't fling.
      const velocity = dt > 0 && e.timeStamp - last.t < HOLD ? (first.y - last.y) / dt : 0;

      const view = root.clientHeight;
      const { top, end } = g.items[g.index] ?? { top: 0, end: 0 };
      const scroll = root.scrollTop;

      if (scroll > end) {
        const pulled = (scroll - end) / RESIST;
        const nextItem = g.items[g.index + 1];
        if (nextItem && (pulled > view * PULL || (pulled > FLICK_PULL && velocity > FLICK_SPEED))) animateTo(nextItem.top, 380);
        else animateTo(end, 260);
      } else if (scroll < top) {
        const pulled = (top - scroll) / RESIST;
        const prevItem = g.items[g.index - 1];
        if (prevItem && (pulled > view * PULL || (pulled > FLICK_PULL && -velocity > FLICK_SPEED))) animateTo(prevItem.top, 380);
        else animateTo(top, 260);
      } else if (Math.abs(velocity) > MIN_SPEED) {
        // Inside a long story: glide on, but never past its edges.
        glide(velocity, top, end);
      }
    };

    const onClick = (e: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
    };

    root.addEventListener('touchstart', onStart, { passive: true });
    root.addEventListener('touchmove', onMove, { passive: false });
    root.addEventListener('touchend', onEnd);
    root.addEventListener('touchcancel', onEnd);
    root.addEventListener('click', onClick, true);
    return () => {
      stop();
      root.classList.remove('feed-paged');
      root.removeEventListener('touchstart', onStart);
      root.removeEventListener('touchmove', onMove);
      root.removeEventListener('touchend', onEnd);
      root.removeEventListener('touchcancel', onEnd);
      root.removeEventListener('click', onClick, true);
    };
  }, [ref, enabled]);
}
