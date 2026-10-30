/** Points the view transition in base.css at the middle of the lamp, and tells it how far it has to go to pass the far corner. */
function aimAt(lamp: Element) {
  const { left, top, width, height } = lamp.getBoundingClientRect();
  const x = left + width / 2;
  const y = top + height / 2;
  const far = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const { style } = document.documentElement;
  style.setProperty('--lamp-x', `${x}px`);
  style.setProperty('--lamp-y', `${y}px`);
  style.setProperty('--lamp-far', `${far}px`);
}

/** Runs `change` as a spread of light from the lamp, or at once where there is no such thing or motion is unwelcome. */
export function spreadFrom(lamp: Element, change: () => void) {
  if (!document.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    change();
    return;
  }
  aimAt(lamp);
  document.startViewTransition(change);
}

/** Runs a change that alters the page's height (the morning band is shorter at night) and scrolls the difference away, so the words at the top of the view stay put. */
export function holdPlace(change: () => void) {
  const top = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop);
  const words = Array.from(document.querySelectorAll('main :is(h1, h2, h3, p, li)'));
  const anchor = words.find((el) => el.getBoundingClientRect().bottom > top);
  if (!anchor) {
    change();
    return;
  }
  const before = anchor.getBoundingClientRect().top;
  change();
  if (anchor.isConnected) window.scrollBy({ top: anchor.getBoundingClientRect().top - before, behavior: 'instant' });
}
