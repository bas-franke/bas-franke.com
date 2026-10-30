import type { CSSProperties } from 'react';
import ContactForm from './ContactForm';
import ResumeButton from './ResumeButton';
import { artUrl } from '../artwork';
import { contact, site } from '../content';

export default function Contact() {
  const art = artUrl('contact-night');

  return (
    <section
      id="contact"
      className="contact night"
      style={art ? ({ '--contact-art': `url(${art})` } as CSSProperties) : undefined}
    >
      <div className="container contact__grid">
        <div className="contact__invite">
          <div className="section__head" data-reveal>
            <p className="eyebrow">{contact.eyebrow}</p>
            <h2>{contact.heading}</h2>
          </div>
          <div data-reveal>
            <p className="lead">{contact.lead}</p>
            <ul className="contact__list">
              <li>
                <span className="contact__label">{contact.form.email}</span>
                <a className="contact__big" href={`mailto:${site.email}`}>
                  {site.email}
                </a>
              </li>
              <li>
                <span className="contact__label">{contact.phone}</span>
                <a className="contact__big" href={site.phoneHref}>
                  {site.phone}
                </a>
              </li>
            </ul>
            <ResumeButton variant="quiet" />
          </div>
        </div>
        <div data-reveal>
          <ContactForm />
        </div>
      </div>
    </section>
  );
}
