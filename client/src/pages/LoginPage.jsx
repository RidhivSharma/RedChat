import { useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import BrandLogo from '../components/BrandLogo.jsx';
import FormField from '../components/FormField.jsx';
import { AlertIcon, EyeIcon, EyeOffIcon } from '../components/icons.jsx';
import { useAuth } from '../hooks/useAuth.js';
import { useToast } from '../hooks/useToast.js';
import { firstInvalidField, validateLogin } from '../utils/validation.js';

const EMPTY_VALUES = { username: '', password: '' };

export default function LoginPage() {
  const { login } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  const [values, setValues] = useState(EMPTY_VALUES);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const usernameRef = useRef(null);
  const passwordRef = useRef(null);
  const fieldRefs = { username: usernameRef, password: passwordRef };

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
    const fieldErrors = validateLogin({ ...values, [name]: value });
    setErrors((current) => ({ ...current, [name]: fieldErrors[name] }));
  }

  async function handleSubmit(event) {
    event.preventDefault();

    const fieldErrors = validateLogin(values);
    setErrors(fieldErrors);

    const firstInvalid = firstInvalidField(fieldErrors);
    if (firstInvalid) {
      fieldRefs[firstInvalid]?.current?.focus();
      return;
    }

    setSubmitting(true);
    setFormError('');

    try {
      const data = await login({ username: values.username.trim(), password: values.password });
      showToast(`Welcome back, ${data.user.displayName}!`, 'success');

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
      <section className="auth-card" aria-labelledby="login-title">
        <header className="auth-card__header">
          <BrandLogo size={44} />
          <h1 className="auth-card__title" id="login-title">
            Welcome back
          </h1>
          <p className="auth-card__subtitle">Sign in to keep the conversation going.</p>
        </header>

        {formError ? (
          <p className="form-error" role="alert">
            <AlertIcon size={18} className="form-error__icon" />
            <span>{formError}</span>
          </p>
        ) : null}

        <form className="auth-form" onSubmit={handleSubmit} noValidate>
          <FormField id="login-username" label="Username" error={errors.username}>
            <input
              ref={usernameRef}
              id="login-username"
              className={`input${errors.username ? ' input--invalid' : ''}`}
              type="text"
              name="username"
              value={values.username}
              onChange={handleChange}
              onBlur={handleBlur}
              placeholder="your_username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              disabled={submitting}
              aria-invalid={errors.username ? 'true' : undefined}
              aria-describedby={errors.username ? 'login-username-error' : undefined}
            />
          </FormField>

          <FormField id="login-password" label="Password" error={errors.password}>
            <div className="input-group">
              <input
                ref={passwordRef}
                id="login-password"
                className={`input${errors.password ? ' input--invalid' : ''}`}
                type={showPassword ? 'text' : 'password'}
                name="password"
                value={values.password}
                onChange={handleChange}
                onBlur={handleBlur}
                placeholder="Your password"
                autoComplete="current-password"
                disabled={submitting}
                aria-invalid={errors.password ? 'true' : undefined}
                aria-describedby={errors.password ? 'login-password-error' : undefined}
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
                Signing in…
              </>
            ) : (
              'Sign in'
            )}
          </button>
        </form>

        <p className="auth-card__footer">
          New to ChatWave? <Link to="/register">Create an account</Link>
        </p>
      </section>
    </main>
  );
}
