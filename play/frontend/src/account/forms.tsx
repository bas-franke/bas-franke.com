import { type FormEvent, type ReactNode, useState } from 'react';
import { AccountError, NICKNAME_MAX, PASSWORD_MIN, cleanNickname, forgot, login, register, rememberReturn, resend } from '../identity';
import './account.css';

/** Turns any thrown value into a message plus the field it belongs to. */
function describe(err: unknown): { message: string; field?: string } {
  if (err instanceof AccountError) return { message: err.message, field: err.field };
  return {
    message: err instanceof Error ? err.message : 'Something went wrong.',
  };
}

const currentPath = () => {
  try {
    return location.pathname + location.search;
  } catch {
    return '/';
  }
};

function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{
    message: string;
    field?: string;
  } | null>(null);
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

/** A small text link styled as a button, for "Forgot password?" and friends. */
export function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="acct-link" onClick={onClick}>
      {children}
    </button>
  );
}

function FieldError({ error, field }: { error: { message: string; field?: string } | null; field: string }) {
  return error?.field === field ? <span className="acct-field-error">{error.message}</span> : null;
}

function FormError({ error, fields }: { error: { message: string; field?: string } | null; fields: string[] }) {
  if (!error || (error.field && fields.includes(error.field))) return null;
  return (
    <p className="error" role="alert">
      {error.message}
    </p>
  );
}

/** Resend the activation mail, with a short cooldown so it can't be hammered. */
export function ResendButton({ email }: { email: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | 'failed'>('idle');
  const click = async () => {
    setState('busy');
    try {
      await resend(email);
      setState('sent');
      setTimeout(() => setState('idle'), 20_000);
    } catch {
      setState('failed');
    }
  };
  return (
    <button type="button" className="btn small" disabled={state === 'busy' || state === 'sent'} onClick={() => void click()}>
      {state === 'sent' ? 'Sent, check your inbox' : state === 'failed' ? 'Could not send, try again' : 'Send the email again'}
    </button>
  );
}

export function LoginForm({
  onDone,
  onForgot,
  onRegister,
  mail = true,
  autoFocus = true,
}: {
  onDone?: () => void;
  onForgot?: () => void;
  onRegister?: () => void;
  /** The server can send mail (resend activation). */
  mail?: boolean;
  autoFocus?: boolean;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [unverified, setUnverified] = useState(false);
  const { busy, error, run } = useBusy();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setUnverified(false);
    void run(async () => {
      try {
        const { reloading } = await login(email.trim(), password);
        if (reloading) return;
      } catch (err) {
        if (err instanceof AccountError && err.unverified) setUnverified(true);
        throw err;
      }
      onDone?.();
    });
  };

  return (
    <form className="acct-form" onSubmit={submit}>
      <label className="field">
        Email
        <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={autoFocus} />
        <FieldError error={error} field="email" />
      </label>
      <label className="field">
        Password
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <FieldError error={error} field="password" />
      </label>
      <FormError error={error} fields={['email', 'password']} />
      {unverified && (
        <div className="acct-hint">
          <span>Click the link in the email we sent you first.</span>
          {mail && <ResendButton email={email.trim()} />}
        </div>
      )}
      <div className="acct-actions">
        {onForgot && <LinkButton onClick={onForgot}>Forgot password?</LinkButton>}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
      </div>
      {onRegister && (
        <p className="acct-switch">
          No account yet? <LinkButton onClick={onRegister}>Create one</LinkButton>
        </p>
      )}
    </form>
  );
}

export function RegisterForm({
  initialNickname = '',
  onLogin,
  onPlayAsGuest,
  onSent,
  autoFocus = true,
}: {
  initialNickname?: string;
  onLogin?: () => void;
  /** Shown on the "check your email" step, so nobody is stuck waiting for mail. */
  onPlayAsGuest?: (nickname: string) => void;
  /** The form switched to its "check your email" step. */
  onSent?: () => void;
  autoFocus?: boolean;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState(initialNickname);
  const [sent, setSent] = useState<{ email: string; devLink?: string } | null>(null);
  const { busy, error, setError, run } = useBusy();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const nick = cleanNickname(nickname);
    if (!nick) return setError({ message: 'Pick a nickname.', field: 'nickname' });
    if (password.length < PASSWORD_MIN)
      return setError({
        message: `At least ${PASSWORD_MIN} characters.`,
        field: 'password',
      });
    void run(async () => {
      rememberReturn(currentPath());
      const res = await register(email.trim(), password, nick);
      setSent({ email: res.email || email.trim(), devLink: res.devLink });
      onSent?.();
    });
  };

  if (sent) {
    return (
      <div className="acct-form acct-sent">
        <div className="acct-sent-icon" aria-hidden="true">
          ✉
        </div>
        <h3>Check your email</h3>
        <p>
          We sent a link to <b>{sent.email}</b>. Click it to finish. It can take a minute; peek in your spam folder too.
        </p>
        {sent.devLink && (
          <p className="acct-dev">
            Local dev, no mail server: <a href={sent.devLink}>open the activation link</a>
          </p>
        )}
        <div className="acct-actions">
          <ResendButton email={sent.email} />
          {onPlayAsGuest && (
            <button type="button" className="btn primary" onClick={() => onPlayAsGuest(cleanNickname(nickname))}>
              Play as guest meanwhile
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <form className="acct-form" onSubmit={submit}>
      <label className="field">
        Nickname
        <input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={NICKNAME_MAX} autoComplete="nickname" required autoFocus={autoFocus && !initialNickname} />
        <FieldError error={error} field="nickname" />
      </label>
      <label className="field">
        Email
        <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={autoFocus && !!initialNickname} />
        <FieldError error={error} field="email" />
      </label>
      <label className="field">
        Password
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={PASSWORD_MIN}
          required
          placeholder={`${PASSWORD_MIN}+ characters`}
        />
        <FieldError error={error} field="password" />
      </label>
      <FormError error={error} fields={['nickname', 'email', 'password']} />
      <div className="acct-actions">
        <span />
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </div>
      {onLogin && (
        <p className="acct-switch">
          Already have one? <LinkButton onClick={onLogin}>Log in</LinkButton>
        </p>
      )}
    </form>
  );
}

export function ForgotForm({ onBack, autoFocus = true }: { onBack?: () => void; autoFocus?: boolean }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<{ devLink?: string } | null>(null);
  const { busy, error, run } = useBusy();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      rememberReturn(currentPath());
      const res = await forgot(email.trim());
      setSent({ devLink: res.devLink });
    });
  };

  if (sent) {
    return (
      <div className="acct-form acct-sent">
        <h3>Check your email</h3>
        <p>
          If <b>{email.trim()}</b> has an account, a reset link is on its way. It works for an hour.
        </p>
        {sent.devLink && (
          <p className="acct-dev">
            Local dev, no mail server: <a href={sent.devLink}>open the reset link</a>
          </p>
        )}
        {onBack && (
          <div className="acct-actions">
            <span />
            <button type="button" className="btn" onClick={onBack}>
              Back to log in
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <form className="acct-form" onSubmit={submit}>
      <p className="acct-lead">Enter your email and we'll send you a link to pick a new password.</p>
      <label className="field">
        Email
        <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={autoFocus} />
        <FieldError error={error} field="email" />
      </label>
      <FormError error={error} fields={['email']} />
      <div className="acct-actions">
        {onBack ? <LinkButton onClick={onBack}>Back to log in</LinkButton> : <span />}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Send reset link'}
        </button>
      </div>
    </form>
  );
}

/** Shown instead of sign-up when the server can't send mail (no activation or reset links possible). */
export function NoMailNote() {
  return <p className="acct-pitch">New accounts and password resets are paused for now. Existing accounts can log in; everyone else plays as a guest, with everything saved in this browser.</p>;
}

/** One line that explains what an account is for. Shared by the gate and the account page. */
export function AccountPitch() {
  return <p className="acct-pitch">An account is optional. It only syncs your nickname, settings and progress across devices. As a guest, everything stays in this browser.</p>;
}
