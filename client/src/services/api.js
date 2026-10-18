// ============================================================================
// ChatWave API client.
//
// Every HTTP call in the app goes through this module (client rule). It:
//   - reads the base URL from VITE_API_URL (see .env.example; must include /api)
//   - attaches the Bearer token from localStorage
//   - parses the server error shape { error: { message, code } } into ApiError
//   - on a 401 (outside login/register themselves) clears the session and
//     redirects to /login
// ============================================================================

// Vite statically replaces `import.meta.env.VITE_API_URL` / `import.meta.env.DEV`
// at build time. In a plain Node import (unit tests) `import.meta.env` does not
// exist, so both reads go through these guards — the module must load outside
// the browser to stay testable.
function readApiUrlEnv() {
  try {
    return import.meta.env.VITE_API_URL;
  } catch {
    return undefined;
  }
}

function isDevBuild() {
  try {
    return import.meta.env.DEV === true;
  } catch {
    return false;
  }
}

const API_URL = (readApiUrlEnv() || '/api').replace(/\/+$/, '');

// Without VITE_API_URL the app falls back to the relative "/api" path, which
// 404s against the Vite dev server. Fail loudly in development so the missing
// client/.env is obvious (see .env.example).
if (isDevBuild() && !readApiUrlEnv()) {
  console.warn(
    '[ChatWave] VITE_API_URL is not set — API calls go to the relative "/api" path and will fail in dev. ' +
      'Copy client/.env.example to client/.env and restart the dev server.'
  );
}

export const TOKEN_STORAGE_KEY = 'chatwave.token';
export const UNAUTHORIZED_EVENT = 'chatwave:unauthorized';

// 401 coming from these calls means "wrong username/password", not "your
// session expired", so they must not clear the session or redirect.
const CREDENTIAL_PATHS = ['/auth/login', '/auth/register'];

export class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) {
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // Storage unavailable (private mode): the session simply stays in memory.
  }
}

export function clearToken() {
  setToken(null);
}

function handleUnauthorized() {
  clearToken();
  // Let React (AuthContext) drop its in-memory session too.
  window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));

  const { pathname } = window.location;
  if (pathname !== '/login' && pathname !== '/register') {
    window.location.assign('/login');
  }
}

async function request(path, { method = 'GET', body, auth = true, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (auth) {
    const token = getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw error;
    }
    throw new ApiError(
      'Cannot reach the server. Check your connection and try again.',
      'NETWORK_ERROR',
      0
    );
  }

  const payload = response.status === 204 ? null : await response.json().catch(() => null);

  if (!response.ok) {
    const message = payload?.error?.message || `Request failed with status ${response.status}`;
    const code = payload?.error?.code || 'REQUEST_FAILED';

    if (response.status === 401 && !CREDENTIAL_PATHS.includes(path)) {
      handleUnauthorized();
    }

    throw new ApiError(message, code, response.status);
  }

  return payload;
}

export const api = {
  get: (path, options) => request(path, { ...options, method: 'GET' }),
  post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
  patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
  delete: (path, options) => request(path, { ...options, method: 'DELETE' }),
};

export const authApi = {
  register: (payload) => request('/auth/register', { method: 'POST', body: payload, auth: false }),
  login: (payload) => request('/auth/login', { method: 'POST', body: payload, auth: false }),
  me: () => request('/auth/me'),
};

function buildQuery(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export const usersApi = {
  /** GET /api/users/search?q= — prefix match on username/displayName, self excluded. */
  search: (term, options) => request(`/users/search${buildQuery({ q: term })}`, options),

  /** GET /api/users/:id — public profile (includes publicKey). */
  get: (userId) => request(`/users/${userId}`),

  /** PATCH /api/users/me — displayName/avatarColor, plus the one-time key setup. */
  updateMe: (payload) => request('/users/me', { method: 'PATCH', body: payload }),
};

export const conversationsApi = {
  /** GET /api/conversations — sorted by lastMessageAt, includes unreadCount. */
  list: () => request('/conversations'),

  /** GET /api/conversations/:id — members only. */
  get: (conversationId) => request(`/conversations/${conversationId}`),

  /**
   * GET /api/conversations/:id/messages?before=&limit=
   * Newest page by default; `before` (message id) walks backwards in history.
   */
  messages: (conversationId, { before, limit } = {}) =>
    request(`/conversations/${conversationId}/messages${buildQuery({ before, limit })}`),

  /** POST /api/conversations/direct { userId } — idempotent. */
  startDirect: (userId) => request('/conversations/direct', { method: 'POST', body: { userId } }),

  /** POST /api/conversations/group { name, memberIds, groupKeys? }. */
  createGroup: (payload) => request('/conversations/group', { method: 'POST', body: payload }),

  /** POST /api/conversations/:id/members { userIds, groupKeys } — group admins only. */
  addMembers: (conversationId, userIds, groupKeys = []) =>
    request(`/conversations/${conversationId}/members`, {
      method: 'POST',
      body: { userIds, groupKeys },
    }),

  /**
   * POST /api/conversations/:id/keys { baseVersion, groupKeys } — group admins
   * only. Rotates the group key after a membership change; the server answers
   * 409 STALE_KEY_VERSION when another admin rotated first.
   */
  rotateKeys: (conversationId, baseVersion, groupKeys) =>
    request(`/conversations/${conversationId}/keys`, {
      method: 'POST',
      body: { baseVersion, groupKeys },
    }),

  /**
   * DELETE /api/conversations/:id/members/:userId — admins removing someone,
   * or a user removing themselves (leaving the group).
   */
  removeMember: (conversationId, userId) =>
    request(`/conversations/${conversationId}/members/${userId}`, { method: 'DELETE' }),

  /** PATCH /api/conversations/:id { name } — group admins only. */
  rename: (conversationId, name) =>
    request(`/conversations/${conversationId}`, { method: 'PATCH', body: { name } }),

  /** POST /api/conversations/:id/admins { userId } — group admins only. */
  promoteAdmin: (conversationId, userId) =>
    request(`/conversations/${conversationId}/admins`, { method: 'POST', body: { userId } }),
};

export default api;
