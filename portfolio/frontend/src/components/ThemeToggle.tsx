import { nav } from '../content';
import { useTheme } from '../hooks/useTheme';

/** A small table lamp: switching it on turns the page to night, so it is lit in dark mode (see nav.css). */
export default function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const label = nav.theme[theme === 'dark' ? 'light' : 'dark'];
  return (
    <button type="button" className="theme" onClick={toggle} aria-label={label} title={label}>
      <svg className="lamp" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
        <circle className="lamp__glow" cx="12" cy="10" r="11" />
        <path className="lamp__shade" d="M8.6 3.5h6.8L18.8 12H5.2z" />
        <path d="M12 12v8M8.5 20.5h7" />
        <path className="lamp__cord" d="M15.5 12v3.6" />
      </svg>
    </button>
  );
}
