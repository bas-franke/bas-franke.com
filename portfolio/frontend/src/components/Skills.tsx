import type { CSSProperties } from 'react';
import { skills } from '../content';

export default function Skills() {
  return (
    <section id="skills" className="section container">
      <div className="section__head" data-reveal>
        <p className="eyebrow">03 — Skills</p>
        <h2>{skills.heading}</h2>
      </div>
      <div className="skills">
        <div className="tiers" data-reveal>
          {skills.tiers.map((tier, i) => (
            <div className="tier" key={tier.name} style={{ '--i': i } as CSSProperties}>
              <div>
                <p className="tier__name">{tier.name}</p>
                <p className="tier__note">{tier.note}</p>
              </div>
              <ul className="tier__list">
                {tier.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <ol className="principles" data-reveal style={{ '--d': '140ms' } as CSSProperties}>
          {skills.principles.map((p, i) => (
            <li className="principle" key={p.title} style={{ '--i': i } as CSSProperties}>
              <h3>{p.title}</h3>
              <p>{p.text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
