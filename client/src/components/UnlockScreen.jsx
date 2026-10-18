import { useRef, useState } from 'react';
import BrandLogo from './BrandLogo.jsx';
import FormField from './FormField.jsx';
import { AlertIcon, EyeIcon, EyeOffIcon, LockIcon } from './icons.jsx';
import { useAuth } from '../hooks/useAuth.js';

/**
 * Shown when a session exists but this device cannot produce the private key
 * (new device, cleared site data, logout in another tab). The password
 * decrypts the server-side key backup locally — it never leaves the browser.
 */
export default function UnlockScreen() {
  const { user, unlockWithPassword, logout } = useAuth();

  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const inputRef = useRef(null);

  async function handleSubmit(event) {
    event.preventDefault();

    if (!password) {
      setError('Enter your password to unlock your key.');
      inputRef.current?.focus();
      return;
    }

    setUnlocking(true);
    setError('');

    try {
      await unlockWithPassword(password);
      // AuthProvider flips keyStatus to 'ready' and the app appears.
      setPassword('');
    } catch (unlockError) {
      setError(unlockError?.message || 'Could not unlock your encryption key.');
      setPassword('');
      inputRef.current?.focus();
    } finally {
      setUnlocking(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="unlock-title">
        <header className="auth-card__header">
          <BrandLogo size={44} />
          <h1 className="auth-card__title" id="unlock-title">
            Unlock your messages
          </h1>
          <p className="auth-card__subtitle">
            {user?.displayName ? `Welcome back, ${user.displayName}. ` : ''}
            This device does not have your private key yet. Enter your password and it will be
            restored from your encrypted backup — it never leaves this browser.
          </p>
        </header>

        <p className="unlock-badge" role="note">
          <LockIcon size={16} />
          End-to-end encrypted
        </p>

        {error ? (
          <p className="form-error" role="alert">
            <AlertIcon size={18} className="form-error__icon" />
            <span>{error}</span>
          </p>
        ) : null}

        <form className="auth-form" onSubmit={handleSubmit} noValidate>
          <FormField id="unlock-password" label="Password">
            <div className="input-group">
              <input
                ref={inputRef}
                id="unlock-password"
                className={`input${error ? ' input--invalid' : ''}`}
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  if (error) setError('');
                }}
                placeholder="Your account password"
                autoComplete="current-password"
                disabled={unlocking}
                aria-invalid={error ? 'true' : undefined}
              />
              <button
                type="button"
                className="input-group__button"
                onClick={() => setShowPassword((visible) => !visible)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
              >
                {showPassword ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
              </button>
            </div>
          </FormField>

          <button
            type="submit"
            className="btn btn--primary btn--block btn--lg"
            disabled={unlocking}
          >
            {unlocking ? (
              <>
                <span className="spinner spinner--sm" aria-hidden="true" />
                Unlocking…
              </>
            ) : (
              'Unlock messages'
            )}
          </button>
        </form>

        <p className="auth-card__footer">
          Not {user?.displayName || 'you'}?{' '}
          <button type="button" className="link-button" onClick={logout}>
            Sign out
          </button>
        </p>
      </section>
    </main>
  );
}
