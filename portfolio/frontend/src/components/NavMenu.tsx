import type { CSSProperties, Ref } from 'react';
import day from '../art/hero.webp';
import nightfall from '../art/hero-dark.webp';
import ResumeButton from './ResumeButton';
import { nav } from '../content';
import { useTheme } from '../hooks/useTheme';

interface Props {
  ref: Ref<HTMLDivElement>;
  open: boolean;
  night: boolean;
  active: string | null;
  onClose: () => void;
}

/** The phone menu: the hero's window fills the screen at the hour the page is at, with the sections in its sky. */
export default function NavMenu({ ref, open, night, active, onClose }: Props) {
  const { theme } = useTheme();
  const className = ['menu', open && 'menu--open', night && 'night'].filter(Boolean).join(' ');

  return (
    <div ref={ref} id="nav-menu" className={className}>
      <img
        className="menu__painting"
        src={night || theme === 'dark' ? nightfall : day}
        alt=""
        width="1200"
        height="1500"
        loading="lazy"
        draggable={false}
      />
      <nav className="menu__links" aria-label={nav.sections}>
        {nav.links.map(({ id, label }, i) => (
          <a
            key={id}
            href={`#${id}`}
            style={{ '--i': i } as CSSProperties}
            aria-current={active === id ? 'true' : undefined}
            onClick={onClose}
          >
            {label}
          </a>
        ))}
      </nav>
      <div className="menu__foot" style={{ '--i': nav.links.length } as CSSProperties}>
        <ResumeButton />
      </div>
    </div>
  );
}
