import type { CSSProperties } from 'react';
import Art from './Art';
import Motif from './Motif';
import { hero } from '../content';

const delay = (ms: number) => ({ '--d': `${ms}ms` }) as CSSProperties;

export default function Hero() {
  return (
    <section className="hero" aria-label="Introduction">
      <div className="container hero__inner">
        <div className="hero__text">
          <p className="eyebrow" data-reveal>
            {hero.eyebrow}
          </p>
          <h1 data-reveal style={delay(120)}>
            {hero.title}
            <br />
            <em>{hero.titleEm}</em>
          </h1>
          <p className="lead" data-reveal style={delay(240)}>
            {hero.lead}
          </p>
          <div className="hero__actions" data-reveal style={delay(360)}>
            <a className="btn" href={hero.primary.href}>
              {hero.primary.label}
            </a>
            <a className="link" href={hero.secondary.href}>
              {hero.secondary.label}
            </a>
          </div>
        </div>
        <div className="hero__art" data-reveal style={delay(200)}>
          <Art name="hero" eager fallback={<Motif kind="horizon" />} />
        </div>
      </div>
      <a className="scroll-cue" href="#about" aria-label="Scroll to the next section">
        <span>Scroll</span>
        <i aria-hidden="true" />
      </a>
    </section>
  );
}
