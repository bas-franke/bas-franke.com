import Mark from './Mark';
import ThemeToggle from './ThemeToggle';
import ResumeButton from './ResumeButton';
import NavMenu from './NavMenu';
import { nav, site } from '../content';
import { useActiveSection } from '../hooks/useActiveSection';
import { useNavMenu } from '../hooks/useNavMenu';
import { useNavScroll } from '../hooks/useNavScroll';

const ids = nav.links.map(({ id }) => id);

export default function Nav() {
  const active = useActiveSection(ids);
  const { scrolled, night } = useNavScroll();
  const { open, setOpen, button, sheet } = useNavMenu();

  const className = ['nav', scrolled && 'nav--scrolled', open && 'nav--open', night && 'night'].filter(Boolean).join(' ');

  return (
    <>
      <header className={className}>
        <div className="container nav__inner">
          <a className="nav__brand" href="#top" aria-label={`${site.name}, ${nav.top}`}>
            <Mark />
            <span>{site.name}</span>
          </a>
          <nav className="nav__links" aria-label={nav.sections}>
            {nav.links.map(({ id, label }) => (
              <a key={id} href={`#${id}`} aria-current={active === id ? 'true' : undefined}>
                {label}
              </a>
            ))}
          </nav>
          <div className="nav__right">
            <ResumeButton variant="nav" />
            <ThemeToggle />
            <button
              ref={button}
              type="button"
              className="nav__menu"
              aria-label={open ? nav.close : nav.menu}
              aria-expanded={open}
              aria-controls="nav-menu"
              onClick={() => setOpen(!open)}
            >
              <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
                <path d="M4 9h16" />
                <path d="M4 15h16" />
              </svg>
            </button>
          </div>
        </div>
      </header>
      <NavMenu ref={sheet} open={open} night={night} active={active} onClose={() => setOpen(false)} />
    </>
  );
}
