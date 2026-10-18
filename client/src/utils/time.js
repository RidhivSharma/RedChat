// Date/time formatting helpers for the chat UI (no date libraries).

const DAY_MS = 24 * 60 * 60 * 1000;

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Difference in whole calendar days between two dates. */
export function daysBetween(from, to) {
  return Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS);
}

/** "14:32" — used for message timestamps. */
export function formatTime(value) {
  const date = toDate(value);
  if (!date) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** "Today" / "Yesterday" / "Monday" / "12 Oct 2025" — message date separators. */
export function formatDayLabel(value) {
  const date = toDate(value);
  if (!date) return '';

  const now = new Date();
  const diff = daysBetween(date, now);

  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return date.toLocaleDateString([], { weekday: 'long' });

  return date.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

/** Compact timestamp for the conversation list. */
export function formatConversationTime(value) {
  const date = toDate(value);
  if (!date) return '';

  const diff = daysBetween(date, new Date());
  if (diff === 0) return formatTime(date);
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return date.toLocaleDateString([], { weekday: 'short' });

  return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** "12 Oct 2025, 14:32" — exact timestamps for receipts/message info. */
export function formatDateTime(value) {
  const date = toDate(value);
  if (!date) return '';

  const now = new Date();
  const day = date.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
  return `${day}, ${formatTime(date)}`;
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function timeAgo(value, now = Date.now()) {
  const date = toDate(value);
  if (!date) return '';

  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (seconds < 45) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Header status line for an offline user: "last seen 4 minutes ago". */
export function formatLastSeen(value) {
  const date = toDate(value);
  if (!date) return 'offline';

  if (daysBetween(date, new Date()) >= 7) {
    return `last seen ${date.toLocaleDateString([], { day: 'numeric', month: 'short' })}`;
  }
  return `last seen ${timeAgo(date)}`;
}
