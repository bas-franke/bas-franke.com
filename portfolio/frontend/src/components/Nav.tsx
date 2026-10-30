import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import Mark from './Mark';
import ThemeToggle from './ThemeToggle';
import ResumeButton from './ResumeButton';
import { nav, site } from '../content';
import { useActiveSection } from '../hooks/useActiveSection';
import { useNavScroll } from '../hooks/useNavScroll';
import { watchScroll } from '../hooks/watchScroll';

const ids = nav.links.map(({ id }) => id);

export default function Nav() {
  const active = useActiveSection(ids);
  const { scrolled, night } = useNavScroll();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLButtonElement>(null);

  // the menu is a shortcut: once the page moves, the visitor has gone on without it
  useEffect(() => watchScroll(() => setOpen(false)), []);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape' && open) {
      setOpen(false);
      menu.current?.focus();
    }
  }

  const className = ['nav', (scrolled || open) && 'nav--scrolled', night && 'night'].filter(Boolean).join(' ');

  return (
    <header className={className} onKeyDown={onKeyDown}>
      <div className="container nav__inner">
        <a className="nav__brand" href="#top" aria-label={`${site.name}, ${nav.top}`}>
          <Mark />
          <span>{site.name}</span>
        </a>
        <button
          ref={menu}
          type="button"
          className="nav__menu"
          aria-expanded={open}
          aria-controls="nav-links"
          onClick={() => setOpen(!open)}
        >
          {nav.menu}
        </button>
        <nav id="nav-links" className={open ? 'nav__links nav__links--open' : 'nav__links'} aria-label={nav.sections}>
          {nav.links.map(({ id, label }) => (
            <a key={id} href={`#${id}`} aria-current={active === id ? 'true' : undefined} onClick={() => setOpen(false)}>
              {label}
            </a>
          ))}
        </nav>
        <div className="nav__right">
          <ResumeButton variant="nav" />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
