import { useEffect, useState, type FormEvent } from 'react';
import { contact, site } from '../content';

type Status = 'idle' | 'invalid' | 'sending' | 'failed' | 'opened' | 'sent';

const copy = contact.form;
const REQUEST_TIMEOUT_MS = 15000;
/** Past this length a mailto link can do nothing at all, without any error, depending on the browser and mail app. */
const MAILTO_LIMIT = 2000;

/** A link to the visitor's own mail app, with everything they typed filled in. */
function mailtoHref(data: FormData): string {
  const subject = `${copy.subject} ${data.get('name')}`;
  const body = `${data.get('message')}\n\n${data.get('name')}\n${data.get('email')}`;
  return `mailto:${site.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** Returns what went wrong, or null when the message is on its way. */
async function sendMessage(data: FormData): Promise<string | null> {
  try {
    const res = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(data.entries())),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error ?? copy.failed;
  } catch {
    return copy.failed;
  }
}

function EmailLink() {
  return <a href={`mailto:${site.email}`}>{site.email}</a>;
}

/**
 * Sends through the backend when it has mail configured (see README), otherwise through the visitor's mail app.
 * Until the backend has answered (`direct` is null) it counts as configured, so an early send isn't turned into a mail draft.
 */
export default function ContactForm() {
  const [direct, setDirect] = useState<boolean | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/contact', { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      .then((res) => (res.ok ? res.json() : { enabled: false }))
      .then((data: { enabled?: boolean }) => setDirect(Boolean(data.enabled)))
      .catch(() => setDirect(false));
  }, []);

  function fail(message: string) {
    setError(message);
    setStatus('failed');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.checkValidity()) {
      form.querySelector<HTMLElement>(':invalid')?.focus();
      setStatus('invalid');
      return;
    }

    const data = new FormData(form);
    if (direct === false) {
      const href = mailtoHref(data);
      if (href.length > MAILTO_LIMIT) {
        fail(copy.failed);
        return;
      }
      window.location.href = href;
      setStatus('opened');
      return;
    }

    setStatus('sending');
    const failure = await sendMessage(data);
    if (failure) fail(failure);
    else setStatus('sent');
  }

  if (status === 'sent') {
    return (
      <div className="form__done" role="status">
        <p className="form__title">{copy.sentTitle}</p>
        <p>{copy.sent}</p>
      </div>
    );
  }

  return (
    <form className={`form ${status === 'idle' ? '' : 'form--checked'}`.trim()} onSubmit={submit} noValidate>
      <h3 className="form__title">{copy.title}</h3>
      <div className="field">
        <label htmlFor="c-name">{copy.name}</label>
        <input id="c-name" name="name" type="text" autoComplete="name" required minLength={2} maxLength={120} />
      </div>
      <div className="field">
        <label htmlFor="c-email">{copy.email}</label>
        <input id="c-email" name="email" type="email" autoComplete="email" required maxLength={200} />
      </div>
      <div className="field">
        <label htmlFor="c-message">{copy.message}</label>
        <textarea id="c-message" name="message" rows={4} required minLength={10} maxLength={5000} />
      </div>
      {/* Honeypot: hidden from people, filled in by bots. The name avoids anything a browser would autofill. */}
      <div className="field field--trap" aria-hidden="true">
        <label htmlFor="c-leave-blank">{copy.trap}</label>
        <input id="c-leave-blank" name="leave_blank" type="text" tabIndex={-1} autoComplete="off" />
      </div>
      <div className="form__actions">
        <button className="btn btn--primary" type="submit" disabled={status === 'sending'}>
          {status === 'sending' ? copy.sending : direct === false ? copy.sendInApp : copy.send}
        </button>
        {status === 'invalid' && (
          <p className="form__note form__note--error" role="alert">
            {copy.invalid}
          </p>
        )}
        {status === 'failed' && (
          <p className="form__note form__note--error" role="alert">
            {error} {copy.orEmail} <EmailLink />.
          </p>
        )}
        {status === 'opened' && (
          <p className="form__note" role="status">
            {copy.opened} <EmailLink />.
          </p>
        )}
      </div>
    </form>
  );
}
