import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { NICKNAME_MAX, cleanNickname, loadAccount, saveName, useAccount } from '../identity';
import { AccountPitch, ForgotForm, LinkButton, LoginForm, NoMailNote, RegisterForm } from './forms';
import './account.css';

/** Mail links must work for people who have never picked a nickname. */
const EXEMPT = /^\/account\/(activate|reset)\//;

type Mode = 'guest' | 'login' | 'register' | 'forgot';

/**
 * Every page needs a nickname: visitors without one (and without a session) pick one here first. Guests always get
 * through with just a name; logging in or creating an account is offered next to it when the server has accounts.
 */
export function IdentityGate({ children }: { children: ReactNode }) {
  const account = useAccount();
  const { pathname } = useLocation();
  // A short grace period before showing the gate, so someone with a session but no name cookie sees no flash.
  const [waited, setWaited] = useState(false);

  useEffect(() => {
    void loadAccount();
    const t = setTimeout(() => setWaited(true), 600);
    return () => clearTimeout(t);
  }, []);

  if (account.name || account.user || EXEMPT.test(pathname)) return <>{children}</>;
  if (!account.loaded && !waited) return <div className="gate-backdrop" />;
  return <Gate enabled={account.enabled} mail={account.mail} />;
}

function Gate({ enabled, mail }: { enabled: boolean; mail: boolean }) {
  const [mode, setMode] = useState<Mode>('guest');
  const [nickname, setNickname] = useState('');
  const [sent, setSent] = useState(false);
  // Without mail delivery nobody can activate a new account or reset a password: only logging in is offered.
  const effective = !enabled ? 'guest' : !mail && (mode === 'register' || mode === 'forgot') ? 'login' : mode;

  const playAsGuest = (raw: string) => saveName(cleanNickname(raw) || 'Player');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    playAsGuest(nickname);
  };

  return (
    <div className="gate-backdrop">
      <div className="gate" role="dialog" aria-modal="true" aria-labelledby="gate-title">
        <div className="gate-brand" aria-hidden="true">
          <span className="brand-mark" />
          <span className="brand-name">
            play<span className="dot">.</span>
          </span>
        </div>

        {effective === 'guest' && (
          <>
            <h1 id="gate-title">What should we call you?</h1>
            <p className="gate-sub">Pick a nickname and jump in. No sign-up needed.</p>
            <form onSubmit={submit} className="gate-form">
              <label className="field">
                <span className="visually-hidden">Nickname</span>
                <input
                  className="gate-input"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  maxLength={NICKNAME_MAX}
                  placeholder="Your nickname"
                  autoComplete="nickname"
                  autoFocus
                  data-testid="gate-name"
                />
              </label>
              <button className="btn primary big gate-play" type="submit" data-testid="gate-guest">
                Play as guest
              </button>
            </form>
            {enabled && (
              <>
                <div className="gate-or">
                  <span>or</span>
                </div>
                <div className={mail ? 'gate-alt' : 'gate-alt single'}>
                  <button type="button" className="btn" onClick={() => setMode('login')}>
                    Log in
                  </button>
                  {mail && (
                    <button type="button" className="btn" onClick={() => setMode('register')}>
                      Create account
                    </button>
                  )}
                </div>
                {mail ? <AccountPitch /> : <NoMailNote />}
              </>
            )}
          </>
        )}

        {effective === 'login' && (
          <>
            <h1 id="gate-title">Welcome back</h1>
            <LoginForm mail={mail} onForgot={mail ? () => setMode('forgot') : undefined} onRegister={mail ? () => setMode('register') : undefined} />
          </>
        )}
        {effective === 'register' && (
          <>
            {!sent && <h1 id="gate-title">Create an account</h1>}
            {!sent && <AccountPitch />}
            <RegisterForm initialNickname={cleanNickname(nickname)} onLogin={() => setMode('login')} onPlayAsGuest={playAsGuest} onSent={() => setSent(true)} />
          </>
        )}
        {effective === 'forgot' && (
          <>
            <h1 id="gate-title">Forgot your password?</h1>
            <ForgotForm onBack={() => setMode('login')} />
          </>
        )}

        {effective !== 'guest' && !sent && (
          <p className="gate-back">
            <LinkButton onClick={() => setMode('guest')}>← Play as guest instead</LinkButton>
          </p>
        )}
      </div>
    </div>
  );
}
