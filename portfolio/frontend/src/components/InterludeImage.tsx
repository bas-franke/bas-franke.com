/** The props each interlude layout takes, from `interludes` in content.ts. */
export interface InterludeProps {
  name: string;
  line: string;
  alt: string;
  nightPainting?: boolean;
}

/** Loads as it comes near; until then the layout shows the picture's own colour, so nothing is ever blank. */
export default function InterludeImage({ src, alt }: { src: string; alt: string }) {
  return <img className="interlude__img" src={src} alt={alt} loading="lazy" decoding="async" draggable={false} />;
}
