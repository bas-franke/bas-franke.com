import type { CSSProperties } from 'react';
import portrait from '../art/profile.jpg';
import { about, site } from '../content';

export default function About() {
  return (
    <section id="about" className="section container">
      <div className="section__head" data-reveal>
        <p className="eyebrow">01 — About</p>
        <h2>{about.heading}</h2>
      </div>
      <div className="about">
        <figure className="portrait" data-reveal>
          <img src={portrait} alt={`Portrait of ${site.name}`} width="960" height="960" loading="lazy" decoding="async" />
        </figure>
        <div className="about__text" data-reveal style={{ '--d': '120ms' } as CSSProperties}>
          {about.paragraphs.map((text) => (
            <p key={text.slice(0, 32)}>{text}</p>
          ))}
          <dl className="facts">
            {about.facts.map(([label, value], i) => (
              <div key={label} style={{ '--i': i } as CSSProperties}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
