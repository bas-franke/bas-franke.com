import type { ReactNode } from 'react';

/** The top bar on every page: the brand on the left, page actions on the right. */
export function Header({ children }: { children?: ReactNode }) {
  return (
    <header className="topbar">
      <a className="brand" href="/">
        play<span className="dot">.</span>
        <small>bas-franke.com</small>
      </a>
      {children && <div className="topbar-actions">{children}</div>}
    </header>
  );
}
