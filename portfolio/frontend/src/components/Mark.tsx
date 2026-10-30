/** The site mark: a sun resting on a horizon line. public/favicon.svg and the two icon PNGs are this drawing. */
export default function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <circle cx="32" cy="29" r="18" fill="currentColor" />
      <rect className="mark__gap" x="4" y="35" width="56" height="4" />
      <rect x="19" y="48" width="26" height="2" rx="1" fill="currentColor" opacity=".5" />
    </svg>
  );
}
