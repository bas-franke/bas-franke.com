import type { CSSProperties } from 'react';
import Art from './Art';
import Motif from './Motif';
import { projects, type Project } from '../content';

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

function Row({ project, index }: { project: Project; index: number }) {
  const body = (
    <>
      <span className="work__index">{String(index + 1).padStart(2, '0')}</span>
      <div className="work__body">
        <p className="work__kind">{project.kind}</p>
        <h3 className="work__title">
          {project.title}
          {project.href && <Arrow />}
        </h3>
        <p className="work__summary">{project.summary}</p>
        <ul className="tags" aria-label="Technologies">
          {project.tags.map((tag) => (
            <li key={tag}>{tag}</li>
          ))}
        </ul>
      </div>
      <figure className="work__art">
        <Art name={`work-${project.slug}`} fallback={<Motif kind={project.motif} />} />
      </figure>
    </>
  );

  if (project.href) {
    return (
      <a className="work__row" href={project.href} target="_blank" rel="noopener noreferrer">
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
        <p className="eyebrow">02 — Work</p>
        <h2>A few things I have built and looked after.</h2>
      </div>
      <ol className="work">
        {projects.map((project, i) => (
          <li key={project.slug} className="work__item" data-reveal style={{ '--d': `${(i % 3) * 80}ms` } as CSSProperties}>
            <Row project={project} index={i} />
          </li>
        ))}
      </ol>
    </section>
  );
}
