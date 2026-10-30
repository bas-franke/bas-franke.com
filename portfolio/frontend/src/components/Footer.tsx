import { footer, site } from '../content';

export default function Footer() {
  return (
    <footer className="footer night">
      <div className="container footer__row">
        <span>
          © {new Date().getFullYear()} {site.name}
        </span>
        <span className="footer__note">{footer.note}</span>
        <a href="#top" className="footer__top">
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path
              d="M1.5 12h13M4.5 12a3.5 3.5 0 0 1 7 0M8 4.5V3M3.4 6.4l1 1M12.6 6.4l-1 1"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>
          {footer.top}
        </a>
      </div>
    </footer>
  );
}
