import HeroWindow from './HeroWindow';
import ResumeButton from './ResumeButton';
import { hero } from '../content';

export default function Hero() {
  return (
    <section className="hero" aria-label={hero.label}>
      <div className="container hero__inner">
        <div className="hero__text">
          <p className="eyebrow">{hero.eyebrow}</p>
          <h1>
            {hero.title}
            <br />
            <em>{hero.titleEm}</em>
          </h1>
          <p className="lead">{hero.lead}</p>
          <div className="hero__actions">
            <ResumeButton />
            <a className="link" href={hero.work.href}>
              {hero.work.label}
            </a>
          </div>
        </div>
        <HeroWindow />
      </div>
    </section>
  );
}
