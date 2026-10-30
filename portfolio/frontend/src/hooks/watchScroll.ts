/** Runs `update` now and on every scroll and resize. Returns what stops it, ready to hand back from an effect. */
export function watchScroll(update: () => void): () => void {
  update();
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  return () => {
    window.removeEventListener('scroll', update);
    window.removeEventListener('resize', update);
  };
}
