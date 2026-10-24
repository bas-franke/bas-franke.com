import { useEffect, useState, type FormEvent } from 'react';
import { contact, site } from '../content';

type Status = 'idle' | 'sending' | 'sent' | 'error';

function Form() {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    setStatus('sending');
    setError('');
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'Something went wrong.');
      setStatus('sent');
      form.reset();
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  if (status === 'sent') {
    return (
      <div className="form__done" role="status">
        <p className="form__done-title">Thank you.</p>
        <p>Your message is on its way. I’ll get back to you soon.</p>
      </div>
    );
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor="c-name">Name</label>
        <input id="c-name" name="name" type="text" autoComplete="name" required minLength={2} maxLength={120} />
      </div>
      <div className="field">
        <label htmlFor="c-email">E-mail</label>
        <input id="c-email" name="email" type="email" autoComplete="email" required maxLength={200} />
      </div>
      <div className="field">
        <label htmlFor="c-message">Message</label>
        <textarea id="c-message" name="message" rows={5} required minLength={10} maxLength={5000} />
      </div>
      {/* Honeypot: hidden from people, filled in by bots. */}
      <div className="field field--trap" aria-hidden="true">
        <label htmlFor="c-company">Company</label>
        <input id="c-company" name="company" type="text" tabIndex={-1} autoComplete="off" />
      </div>
      <div className="form__actions">
        <button className="btn" type="submit" disabled={status === 'sending'}>
          {status === 'sending' ? 'Sending…' : 'Send message'}
        </button>
        {status === 'error' && (
          <p className="form__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}

export default function Contact() {
  // The form only appears when the backend has mail configured (see README), so nothing can silently fail.
  const [formEnabled, setFormEnabled] = useState(false);

  useEffect(() => {
    fetch('/api/contact')
      .then((res) => (res.ok ? res.json() : { enabled: false }))
      .then((data: { enabled?: boolean }) => setFormEnabled(Boolean(data.enabled)))
      .catch(() => setFormEnabled(false));
  }, []);

  return (
    <section id="contact" className="section container">
      <div className="section__head" data-reveal>
        <p className="eyebrow">04 — Contact</p>
        <h2>{contact.heading}</h2>
      </div>
      <div className={`contact ${formEnabled ? 'contact--with-form' : ''}`.trim()}>
        <div className="contact__text" data-reveal>
          <p className="lead">{contact.lead}</p>
          <ul className="contact__list">
            <li>
              <span className="eyebrow">E-mail</span>
              <a className="contact__big" href={`mailto:${site.email}`}>
                {site.email}
              </a>
            </li>
            <li>
              <span className="eyebrow">Phone</span>
              <a className="contact__big" href={site.phoneHref}>
                {site.phone}
              </a>
            </li>
          </ul>
        </div>
        {formEnabled && (
          <div className="contact__form">
            <Form />
          </div>
        )}
      </div>
    </section>
  );
}
