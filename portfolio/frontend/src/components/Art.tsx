/** Artwork from src/art (see ART.md). Files are picked up at build time. */
const files = import.meta.glob<string>('../art/*.{webp,png,jpg,jpeg}', { eager: true, import: 'default' });

export function artUrl(name: string): string | undefined {
  for (const ext of ['webp', 'png', 'jpg', 'jpeg']) {
    const url = files[`../art/${name}.${ext}`];
    if (url) return url;
  }
  return undefined;
}
