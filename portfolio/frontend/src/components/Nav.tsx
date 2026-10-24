import { useEffect, useState } from 'react';
import Mark from './Mark';
import ThemeToggle from './ThemeToggle';
import ResumeButton from './ResumeButton';
import { site } from '../content';
import { useActiveSection } from '../hooks/useActiveSection';

const links: [string, string][] = [
  ['about', 'About'],
  ['work', 'Work'],
  ['skills', 'Skills'],
  ['contact', 'Contact'],
];

const ids = links.map(([id]) => id);

export default function Nav() {
  const active = useActiveSection(ids);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 12);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);

  return (
    <header className={`nav ${scrolled ? 'nav--scrolled' : ''}`.trim()}>
      <a className="nav__brand" href="#top" aria-label={`${site.name}, back to top`}>
        <Mark />
        <span>{site.name}</span>
      </a>
      <nav className="nav__links" aria-label="Sections">
        {links.map(([id, label]) => (
          <a key={id} href={`#${id}`} aria-current={active === id ? 'true' : undefined}>
            {label}
          </a>
        ))}
      </nav>
      <div className="nav__right">
        <ResumeButton variant="nav" />
        <ThemeToggle />
      </div>
    </header>
  );
}
