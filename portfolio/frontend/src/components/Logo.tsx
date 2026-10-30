/** Company mark from src/art/logos/<slug>.png. Renders nothing when the file is missing. */
const logos = import.meta.glob<string>('../art/logos/*.png', { eager: true, import: 'default' });

export default function Logo({ slug }: { slug: string }) {
  const url = logos[`../art/logos/${slug}.png`];
  if (!url) return null;
  return <img className="logo" src={url} alt="" width="28" height="28" loading="lazy" decoding="async" draggable={false} />;
}
