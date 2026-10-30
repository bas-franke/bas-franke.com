import type { CSSProperties } from 'react';
import portrait from '../art/profile.jpg';
import { about } from '../content';

export default function About() {
  return (
    <section id="about" className="section about">
      <div className="window-light" aria-hidden="true" />
      <div className="container about__inner">
        <h2 className="about__statement" data-reveal>
          {about.statement}
        </h2>
        <figure className="portrait" data-reveal>
          <img src={portrait} alt={about.portraitAlt} width="960" height="960" loading="lazy" decoding="async" />
        </figure>
        <div className="about__text" data-reveal>
          {about.paragraphs.map((text) => (
            <p key={text.slice(0, 32)}>{text}</p>
          ))}
        </div>
        <dl className="facts" data-reveal>
          {about.facts.map(([label, value], i) => (
            <div key={label} style={{ '--i': i } as CSSProperties}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
