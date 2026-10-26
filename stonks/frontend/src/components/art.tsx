// The owner's artwork (desk at dusk, sleeping cat). Vite fingerprints these files.
import hero1280 from '../assets/hero-1280.webp';
import hero2048 from '../assets/hero-2048.webp';
import heroScene from '../assets/hero-scene-831.webp';
import empty360 from '../assets/empty-360.webp';
import empty720 from '../assets/empty-720.webp';
import type { ReactNode } from 'react';

export function HeroBanner({ children }: { children: ReactNode }) {
  return (
    <section className="hero">
      <picture>
        <source media="(max-width: 760px)" srcSet={heroScene} />
        <img src={hero1280} srcSet={`${hero1280} 1280w, ${hero2048} 2048w`} sizes="(max-width: 1180px) 100vw, 1180px" alt="" />
      </picture>
      <div className="hero-copy">{children}</div>
    </section>
  );
}

export const SleepingCatArt = ({ className = 'empty-art', width = 300 }: { className?: string; width?: number }) => (
  <img
    className={className}
    src={empty360}
    srcSet={`${empty360} 360w, ${empty720} 720w`}
    sizes={`${width}px`}
    width={width}
    height={Math.round((width * 283) / 360)}
    alt="A white cat asleep by a tablet showing candles, with a lamp and a cup of tea"
  />
);

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <SleepingCatArt />
      <h3>{title}</h3>
      {children && <p className="small" style={{ maxWidth: '46ch' }}>{children}</p>}
      {action}
    </div>
  );
}
