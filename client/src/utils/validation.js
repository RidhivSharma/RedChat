// Client-side validation.
//
// The rules and messages mirror the zod schemas in
// server/src/routes/auth.routes.js so the user sees the same errors before
// (client) and after (server) submitting.

export const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;

export function validateUsername(value) {
  const username = String(value ?? '').trim();
  if (!username) return 'Username is required';
  if (username.length < 3) return 'Username must be at least 3 characters';
  if (username.length > 20) return 'Username must be at most 20 characters';
  if (!USERNAME_PATTERN.test(username)) {
    return 'Username can only contain letters, numbers and underscores';
  }
  return null;
}

export function validateDisplayName(value) {
  const displayName = String(value ?? '').trim();
  if (!displayName) return 'Display name is required';
  if (displayName.length > 40) return 'Display name must be at most 40 characters';
  return null;
}

export function validateNewPassword(value) {
  const password = String(value ?? '');
  if (!password) return 'Password is required';
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (password.length > 72) return 'Password must be at most 72 characters';
  return null;
}

// Login only requires the fields to be present (same as the server schema).
export function validateLogin(values) {
  return {
    username: String(values.username ?? '').trim() ? null : 'Username is required',
    password: String(values.password ?? '') ? null : 'Password is required',
  };
}

export function validateRegistration(values) {
  return {
    username: validateUsername(values.username),
    displayName: validateDisplayName(values.displayName),
    password: validateNewPassword(values.password),
  };
}

export function firstInvalidField(errors) {
  return Object.keys(errors).find((field) => Boolean(errors[field])) ?? null;
}
