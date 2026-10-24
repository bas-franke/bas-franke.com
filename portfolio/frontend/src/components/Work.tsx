import type { CSSProperties } from 'react';
import Art from './Art';
import Logo from './Logo';
import Motif from './Motif';
import { experience, work, type Experience } from '../content';

function Arrow() {
  return (
    <svg className="arrow" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M3.5 12.5 12.5 3.5M5.5 3.5h7v7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Row({ item, index }: { item: Experience; index: number }) {
  const meta = [item.period, item.location].filter(Boolean).join(' · ');
  const body = (
    <>
      <span className="work__index">{String(index + 1).padStart(2, '0')}</span>
      <div className="work__body">
        <p className="work__kind">{item.role}</p>
        <h3 className="work__title">
          <Logo slug={item.slug} />
          <span>{item.company}</span>
          {item.href && <Arrow />}
        </h3>
        {meta && <p className="work__meta">{meta}</p>}
        <p className="work__summary">{item.summary}</p>
        <ul className="tags" aria-label="Skills used">
          {item.tags.map((tag) => (
            <li key={tag}>{tag}</li>
          ))}
        </ul>
      </div>
      <figure className="work__art">
        <Art name={`work-${item.slug}`} fallback={<Motif kind={item.motif} />} />
      </figure>
    </>
  );

  if (item.href) {
    return (
      <a className="work__row" href={item.href} target="_blank" rel="noopener noreferrer">
        {body}
      </a>
    );
  }
  return <div className="work__row">{body}</div>;
}

export default function Work() {
  return (
    <section id="work" className="section container">
      <div className="section__head" data-reveal>
        <p className="eyebrow">02 — Experience</p>
        <h2>{work.heading}</h2>
      </div>
      <ol className="work">
        {experience.map((item, i) => (
          <li key={item.slug} className="work__item" data-reveal style={{ '--d': `${(i % 3) * 80}ms` } as CSSProperties}>
            <Row item={item} index={i} />
          </li>
        ))}
      </ol>
    </section>
  );
}
