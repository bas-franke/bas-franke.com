import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import Mark from './Mark';
import ThemeToggle from './ThemeToggle';
import ResumeButton from './ResumeButton';
import { nav, site } from '../content';
import { useActiveSection } from '../hooks/useActiveSection';

const ids = nav.links.map(({ id }) => id);

/** The night reaches the bar while the first night part of the page is still this far down the screen, on the sunset. */
const NIGHTFALL = 0.25;

export default function Nav() {
  const active = useActiveSection(ids);
  const [scrolled, setScrolled] = useState(false);
  const [night, setNight] = useState(false);
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dusk = document.querySelector('.interlude__stage, #contact');
    const update = () => {
      setScrolled(window.scrollY > 12);
      setNight(dusk !== null && dusk.getBoundingClientRect().top < window.innerHeight * NIGHTFALL);
      setOpen(false);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

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
