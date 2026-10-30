import type { CSSProperties } from 'react';
import portrait from '../art/profile.jpg';
import { about } from '../content';

export default function About() {
  const [lead, ...rest] = about.paragraphs;

  return (
    <section id="about" className="section container about">
      <div className="section__head about__head" data-reveal>
        <h2>{about.heading}</h2>
      </div>
      <p className="about__lead" data-reveal>
        {lead}
      </p>
      <figure className="portrait" data-reveal>
        <img src={portrait} alt={about.portraitAlt} width="960" height="960" loading="lazy" decoding="async" />
      </figure>
      <div className="about__text" data-reveal>
        {rest.map((text) => (
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
    </section>
  );
}
