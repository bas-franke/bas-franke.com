/** The optional paintings in src/art (see ART.md): picked up at build time, so adding a file takes no code. */
const paintings = import.meta.glob<string>('./art/*.webp', { eager: true, import: 'default' });

export function artUrl(name: string): string | undefined {
  return paintings[`./art/${name}.webp`];
}
