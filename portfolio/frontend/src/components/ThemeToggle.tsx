import { useTheme } from '../hooks/useTheme';

export default function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button type="button" className="theme" onClick={toggle} aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
        {theme === 'dark' ? (
          <>
            <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <line x1="12" y1="2.5" x2="12" y2="5" />
              <line x1="12" y1="19" x2="12" y2="21.5" />
              <line x1="2.5" y1="12" x2="5" y2="12" />
              <line x1="19" y1="12" x2="21.5" y2="12" />
              <line x1="5.3" y1="5.3" x2="7" y2="7" />
              <line x1="17" y1="17" x2="18.7" y2="18.7" />
              <line x1="5.3" y1="18.7" x2="7" y2="17" />
              <line x1="17" y1="7" x2="18.7" y2="5.3" />
            </g>
          </>
        ) : (
          <path
            d="M14.5 3.2a8.5 8.5 0 1 0 6.3 11.6A7 7 0 0 1 14.5 3.2z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        )}
      </svg>
    </button>
  );
}
