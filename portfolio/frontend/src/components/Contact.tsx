import ContactForm from './ContactForm';
import { artUrl } from '../artwork';
import { contact, site } from '../content';

export default function Contact() {
  const art = artUrl('contact-night');

  return (
    <section id="contact" className="contact night">
      {art && <img className="contact__art" src={art} alt="" loading="lazy" decoding="async" />}
      <div className="container contact__grid">
        <div>
          <div className="section__head" data-reveal>
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
          </div>
        </div>
        <div data-reveal>
          <ContactForm />
        </div>
      </div>
    </section>
  );
}
