import { useEffect, useRef, useState } from 'react';
import Mark from './Mark';
import ThemeToggle from './ThemeToggle';
import ResumeButton from './ResumeButton';
import { nav, site } from '../content';
import { useActiveSection } from '../hooks/useActiveSection';
import { useNavScroll } from '../hooks/useNavScroll';

const ids = nav.links.map(({ id }) => id);

export default function Nav() {
  const active = useActiveSection(ids);
  const { scrolled, night } = useNavScroll();
  const [open, setOpen] = useState(false);
  const header = useRef<HTMLElement>(null);
  const menu = useRef<HTMLButtonElement>(null);
  const links = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        menu.current?.focus();
      }
    }

    function onPointerDown({ target }: PointerEvent) {
      if (!header.current?.contains(target as Node)) setOpen(false);
    }

    // the menu is a shortcut: once the page moves, the visitor has gone on without it
    function onMove() {
      if (links.current?.contains(document.activeElement)) menu.current?.focus();
      setOpen(false);
    }

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('scroll', onMove, { passive: true });
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('scroll', onMove);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  const className = ['nav', (scrolled || open) && 'nav--scrolled', open && 'nav--open', night && 'night'].filter(Boolean).join(' ');

  return (
    <header ref={header} className={className}>
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
        <nav ref={links} id="nav-links" className={open ? 'nav__links nav__links--open' : 'nav__links'} aria-label={nav.sections}>
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
