/**
 * Company mark from src/art/logos/<slug>.(png|svg|webp|jpg). Renders nothing when the file is missing.
 */
const logos = import.meta.glob<string>('../art/logos/*.{png,svg,webp,jpg}', { eager: true, import: 'default' });

export default function Logo({ slug, alt = '' }: { slug: string; alt?: string }) {
  const url = ['png', 'svg', 'webp', 'jpg'].map((ext) => logos[`../art/logos/${slug}.${ext}`]).find(Boolean);
  if (!url) return null;
  return <img className="logo" src={url} alt={alt} width="28" height="28" loading="lazy" decoding="async" draggable={false} />;
}
