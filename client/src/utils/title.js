// Single owner of document.title: pages set their base title through
// usePageTitle(), the chat layer contributes the unread counter. Keeping both
// in one module prevents the two writers from overwriting each other.

export const APP_NAME = 'ChatWave';

let baseTitle = APP_NAME;
let unreadCount = 0;

function render() {
  if (typeof document === 'undefined') return;
  const prefix = unreadCount > 0 ? `(${unreadCount > 99 ? '99+' : unreadCount}) ` : '';
  document.title = `${prefix}${baseTitle}`;
}

/** Sets the page-specific part, e.g. setPageTitle('Sign in') → "Sign in · ChatWave". */
export function setPageTitle(title) {
  const clean = String(title ?? '').trim();
  baseTitle = clean ? `${clean} · ${APP_NAME}` : APP_NAME;
  render();
}

/** The unread badge prefix, maintained by the chat layer. */
export function setUnreadTitleCount(count) {
  const next = Number.isFinite(count) ? Math.floor(count) : 0;
  unreadCount = next > 0 ? next : 0;
  render();
}
