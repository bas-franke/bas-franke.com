import { useEffect, useState } from 'react';

// Fullscreen for the whole site: the document element goes fullscreen, so it stays that way across page changes in
// the app. iPhones have no element fullscreen; there the way in is Add to Home Screen, which opens the site as a
// fullscreen web app (see manifest.webmanifest).

type Doc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> };
type El = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };

const doc = () => document as Doc;

/** The browser can put the page in fullscreen. */
export function canFullscreen() {
  if (typeof document === 'undefined') return false;
  const el = document.documentElement as El;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen) && (document.fullscreenEnabled ?? true);
}

export function isFullscreen() {
  return !!(doc().fullscreenElement || doc().webkitFullscreenElement);
}

/** Opened from the home screen (already fullscreen, or as close as the device allows). */
export function isStandalone() {
  return window.matchMedia?.('(display-mode: fullscreen), (display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** iPhone or iPad Safari, where the only fullscreen is the home screen app. */
export function isIos() {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

export async function enterFullscreen() {
  const el = document.documentElement as El;
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
    else await el.webkitRequestFullscreen?.();
  } catch {
    // Refused (no user gesture, or a browser policy): the page simply stays as it is.
  }
}

export async function exitFullscreen() {
  try {
    if (document.exitFullscreen) await document.exitFullscreen();
    else await doc().webkitExitFullscreen?.();
  } catch {
    // Already out.
  }
}

export function toggleFullscreen() {
  return isFullscreen() ? exitFullscreen() : enterFullscreen();
}

/** Live fullscreen state for buttons. */
export function useFullscreen() {
  const [active, setActive] = useState(isFullscreen);
  useEffect(() => {
    const on = () => setActive(isFullscreen());
    document.addEventListener('fullscreenchange', on);
    document.addEventListener('webkitfullscreenchange', on);
    return () => {
      document.removeEventListener('fullscreenchange', on);
      document.removeEventListener('webkitfullscreenchange', on);
    };
  }, []);
  return { supported: canFullscreen(), active, toggle: toggleFullscreen };
}

export function FullscreenIcon({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {active ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
    </svg>
  );
}
