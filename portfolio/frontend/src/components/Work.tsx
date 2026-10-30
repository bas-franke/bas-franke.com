import Logo from './Logo';
import Mark from './Mark';
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

function Job({ item }: { item: Experience }) {
  return (
    <div className="work__row">
      <span className="work__mark">
        <Logo slug={item.slug} />
      </span>
      <div className="work__body">
        <h3 className="work__title">
          {item.href ? (
            <a className="work__link" href={item.href} target="_blank" rel="noopener noreferrer">
              {item.company}
              <span className="sr-only">{work.newTab}</span>
              <Arrow />
            </a>
          ) : (
            item.company
          )}
        </h3>
        <p className="work__role">{item.role}</p>
        <p className="work__meta">
          <span>{item.period}</span>
          {item.location && <span>{item.location}</span>}
        </p>
        <p className="work__summary">{item.summary}</p>
        <ul className="work__tags" aria-label="Skills used">
          {item.tags.map((tag) => (
            <li key={tag}>{tag}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function Work() {
  const jobs = experience.filter((item) => item.period);
  const others = experience.filter((item) => !item.period);

  return (
    <section id="work" className="section container">
      <div className="section__head" data-reveal>
        <h2>
          {work.heading}
          <br />
          <em>{work.headingEm}</em>
        </h2>
      </div>
      <div className="work">
        {/* A hairline down the list; the half-sun of the site mark travels along it as the list scrolls by. */}
        <div className="work__rail" aria-hidden="true">
          <div className="work__sun">
            <Mark size={34} />
          </div>
        </div>
        <ol className="work__list">
          {jobs.map((item) => (
            <li key={item.slug} className={item.current ? 'work__item work__item--current' : 'work__item'} data-reveal>
              <Job item={item} />
            </li>
          ))}
        </ol>
      </div>
      {others.map((item) => (
        <p key={item.slug} className="work__aside" data-reveal>
          <strong>{item.company}</strong> · {item.role}. {item.summary}
        </p>
      ))}
    </section>
  );
}
