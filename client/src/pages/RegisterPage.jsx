import { useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import BrandLogo from '../components/BrandLogo.jsx';
import FormField from '../components/FormField.jsx';
import { AlertIcon, EyeIcon, EyeOffIcon } from '../components/icons.jsx';
import { useAuth } from '../hooks/useAuth.js';
import { useToast } from '../hooks/useToast.js';
import { firstInvalidField, validateRegistration } from '../utils/validation.js';

const EMPTY_VALUES = { username: '', displayName: '', password: '' };

export default function RegisterPage() {
  const { register } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  const [values, setValues] = useState(EMPTY_VALUES);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const usernameRef = useRef(null);
  const displayNameRef = useRef(null);
  const passwordRef = useRef(null);
  const fieldRefs = {
    username: usernameRef,
    displayName: displayNameRef,
    password: passwordRef,
  };

  function handleChange(event) {
    const { name, value } = event.target;
    setValues((current) => ({ ...current, [name]: value }));
    if (errors[name]) {
      setErrors((current) => ({ ...current, [name]: null }));
    }
    if (formError) setFormError('');
  }

  function handleBlur(event) {
    const { name, value } = event.target;
    const fieldErrors = validateRegistration({ ...values, [name]: value });
    setErrors((current) => ({ ...current, [name]: fieldErrors[name] }));
  }

  async function handleSubmit(event) {
    event.preventDefault();

    const fieldErrors = validateRegistration(values);
    setErrors(fieldErrors);

    const firstInvalid = firstInvalidField(fieldErrors);
    if (firstInvalid) {
      fieldRefs[firstInvalid]?.current?.focus();
      return;
    }

    setSubmitting(true);
    setFormError('');

    try {
      const data = await register({
        username: values.username.trim(),
        displayName: values.displayName.trim(),
        password: values.password,
      });
      showToast(`Account created — welcome, ${data.user.displayName}!`, 'success');

      const from = location.state?.from?.pathname;
      navigate(from && from !== '/login' && from !== '/register' ? from : '/', { replace: true });
    } catch (error) {
      setFormError(error.message || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="register-title">
        <header className="auth-card__header">
          <BrandLogo size={44} />
          <h1 className="auth-card__title" id="register-title">
            Create your account
          </h1>
          <p className="auth-card__subtitle">
            A minute from now you will be chatting on ChatWave.
          </p>
        </header>

        {formError ? (
          <p className="form-error" role="alert">
            <AlertIcon size={18} className="form-error__icon" />
            <span>{formError}</span>
          </p>
        ) : null}

        <form className="auth-form" onSubmit={handleSubmit} noValidate>
          <FormField id="register-username" label="Username" error={errors.username}>
            <input
              ref={usernameRef}
              id="register-username"
              className={`input${errors.username ? ' input--invalid' : ''}`}
              type="text"
              name="username"
              value={values.username}
              onChange={handleChange}
              onBlur={handleBlur}
              placeholder="e.g. ada_lovelace"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              disabled={submitting}
              aria-invalid={errors.username ? 'true' : undefined}
              aria-describedby={errors.username ? 'register-username-error' : undefined}
            />
          </FormField>

          <FormField id="register-display-name" label="Display name" error={errors.displayName}>
            <input
              ref={displayNameRef}
              id="register-display-name"
              className={`input${errors.displayName ? ' input--invalid' : ''}`}
              type="text"
              name="displayName"
              value={values.displayName}
              onChange={handleChange}
              onBlur={handleBlur}
              placeholder="The name other people will see"
              autoComplete="name"
              disabled={submitting}
              aria-invalid={errors.displayName ? 'true' : undefined}
              aria-describedby={errors.displayName ? 'register-display-name-error' : undefined}
            />
          </FormField>

          <FormField
            id="register-password"
            label="Password"
            error={errors.password}
            hint="Use 8–72 characters you do not use anywhere else."
          >
            <div className="input-group">
              <input
                ref={passwordRef}
                id="register-password"
                className={`input${errors.password ? ' input--invalid' : ''}`}
                type={showPassword ? 'text' : 'password'}
                name="password"
                value={values.password}
                onChange={handleChange}
                onBlur={handleBlur}
                placeholder="Create a password"
                autoComplete="new-password"
                disabled={submitting}
                aria-invalid={errors.password ? 'true' : undefined}
                aria-describedby={errors.password ? 'register-password-error' : undefined}
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

          <button type="submit" className="btn btn--primary btn--block btn--lg" disabled={submitting}>
            {submitting ? (
              <>
                <span className="spinner spinner--sm" aria-hidden="true" />
                Creating account…
              </>
            ) : (
              'Create account'
            )}
          </button>
        </form>

        <p className="auth-card__footer">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </section>
    </main>
  );
}
