import { useEffect, useState } from 'react';
import { isTouchDevice } from '../engine/touch';
import { canFullscreen, enterFullscreen, isFullscreen, isIos, isStandalone } from './fullscreen';

const DISMISSED = 'play:fullscreen-asked';

function asked() {
  try {
    return sessionStorage.getItem(DISMISSED) === '1';
  } catch {
    return false;
  }
}

function remember() {
  try {
    sessionStorage.setItem(DISMISSED, '1');
  } catch {
    // Private mode: we may ask again on the next load, which is fine.
  }
}

/**
 * On phones and tablets, a small sheet on arrival offering fullscreen (browsers only allow it from a tap). On iPhone,
 * where web pages cannot go fullscreen, it explains Add to Home Screen instead. Asked once per visit.
 */
export function FullscreenPrompt() {
  const [mode, setMode] = useState<'fullscreen' | 'homescreen' | null>(null);

  useEffect(() => {
    if (!isTouchDevice() || asked() || isStandalone() || isFullscreen()) return;
    const next = canFullscreen() ? 'fullscreen' : isIos() ? 'homescreen' : null;
    // A beat after load, so it slides in over the page instead of flashing with it.
    const t = setTimeout(() => setMode(next), 600);
    return () => clearTimeout(t);
  }, []);

  if (!mode) return null;
  const close = () => {
    remember();
    setMode(null);
  };

  return (
    <div className="fs-prompt" role="dialog" aria-modal="false" aria-labelledby="fs-title">
      <div className="fs-glow" aria-hidden="true">
        <FsArt />
      </div>
      <div className="fs-text">
        <h2 id="fs-title">{mode === 'fullscreen' ? 'Play fullscreen?' : 'Want it fullscreen?'}</h2>
        {mode === 'fullscreen' ? (
          <p>More room for the games, no browser bars in the way. You can switch back any time with the corner button.</p>
        ) : (
          <p>
            Tap <ShareIcon /> <b>Share</b>, then <b>Add to Home Screen</b>. Open play from there and it runs fullscreen.
          </p>
        )}
      </div>
      <div className="fs-actions">
        {mode === 'fullscreen' ? (
          <>
            <button type="button" className="btn ghost" onClick={close}>
              Not now
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                close();
                void enterFullscreen();
              }}
            >
              Go fullscreen
            </button>
          </>
        ) : (
          <button type="button" className="btn primary" onClick={close}>
            Got it
          </button>
        )}
      </div>
    </div>
  );
}

function FsArt() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="2.5" width="12" height="19" rx="3" />
      <path d="M9 7.5V6h1.5M15 7.5V6h-1.5M9 16.5V18h1.5M15 16.5V18h-1.5" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-label="the share icon" style={{ verticalAlign: '-2px' }}>
      <path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </svg>
  );
}
