import type { ReactNode } from 'react';
import { AccountChip } from '../account/AccountChip';
import { FullscreenIcon, useFullscreen } from './fullscreen';

/** The top bar on every page: the brand on the left, page actions, the account chip and the fullscreen toggle on the right. */
export function Header({ children }: { children?: ReactNode }) {
  const fs = useFullscreen();
  return (
    <header className="topbar">
      <a className="brand" href="/">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">
          play<span className="dot">.</span>
        </span>
        <small>bas-franke.com</small>
      </a>
      <div className="topbar-actions">
        {children}
        <AccountChip />
        {fs.supported && (
          <button type="button" className="icon-btn fs-toggle" onClick={() => void fs.toggle()} aria-label={fs.active ? 'Exit fullscreen' : 'Fullscreen'} title={fs.active ? 'Exit fullscreen' : 'Fullscreen'}>
            <FullscreenIcon active={fs.active} />
          </button>
        )}
      </div>
    </header>
  );
}
