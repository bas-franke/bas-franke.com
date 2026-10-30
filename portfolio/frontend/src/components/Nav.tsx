import Mark from './Mark';
import ThemeToggle from './ThemeToggle';
import ResumeButton from './ResumeButton';
import { nav, site } from '../content';
import { useActiveSection } from '../hooks/useActiveSection';
import { useNavMenu } from '../hooks/useNavMenu';
import { useNavScroll } from '../hooks/useNavScroll';

const ids = nav.links.map(({ id }) => id);

export default function Nav() {
  const active = useActiveSection(ids);
  const { scrolled, night } = useNavScroll();
  const { open, setOpen, bar, button, links } = useNavMenu();

  const className = ['nav', (scrolled || open) && 'nav--scrolled', open && 'nav--open', night && 'night'].filter(Boolean).join(' ');

  return (
    <>
      <header ref={bar} className={className}>
        <div className="container nav__inner">
          <a className="nav__brand" href="#top" aria-label={`${site.name}, ${nav.top}`}>
            <Mark />
            <span>{site.name}</span>
          </a>
          <button
            ref={button}
            type="button"
            className="nav__menu"
            aria-expanded={open}
            aria-controls="nav-links"
            onClick={() => setOpen(!open)}
          >
            {open ? nav.close : nav.menu}
          </button>
          <nav ref={links} id="nav-links" className="nav__links" aria-label={nav.sections}>
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
      {open && <div className="nav__scrim" />}
    </>
  );
}
