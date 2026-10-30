import type { CSSProperties } from 'react';
import { skills } from '../content';

export default function Skills() {
  return (
    <section id="skills" className="section skills">
      <div className="window-light" aria-hidden="true" />
      <div className="container">
        <div className="section__head" data-reveal>
          <h2>{skills.approach}</h2>
        </div>
        <ul className="principles" data-reveal>
          {skills.principles.map((p, i) => (
            <li className="principle" key={p.title} style={{ '--i': i } as CSSProperties}>
              <h3>{p.title}</h3>
              <p>{p.text}</p>
            </li>
          ))}
        </ul>
        <div className="tools" data-reveal>
          <h2 className="tools__heading">{skills.heading}</h2>
          <div className="tiers">
            {skills.tiers.map((tier, i) => (
              <div className="tier" key={tier.name} style={{ '--i': i } as CSSProperties}>
                <div className="tier__head">
                  <h3 className="tier__name">{tier.name}</h3>
                  <p className="tier__note">{tier.note}</p>
                </div>
                <p className="tier__items">{tier.items.join(', ')}.</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
