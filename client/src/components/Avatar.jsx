const FALLBACK_COLOR = '#0d9488';

function pickInitials(name) {
  const parts = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Pick white or dark text depending on the avatar color's luminance, so the
// initials stay readable for every color in the server palette.
function readableTextColor(hexColor) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hexColor ?? ''));
  if (!match) return '#ffffff';

  const value = Number.parseInt(match[1], 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];

  return luminance > 0.45 ? '#0f172a' : '#ffffff';
}

/**
 * Avatar — initials on the user's avatarColor.
 *
 * <Avatar user={user} />            → displayName/username initials
 * <Avatar name="Ada Lovelace" size="lg" /> → initials with the fallback color
 * <Avatar name="Team standup" color="#3b82f6" /> → group avatar
 */
export default function Avatar({ user, name, color, size = 'md', className = '', title }) {
  const label = user?.displayName || user?.username || name || '?';
  const backgroundColor = user?.avatarColor || color || FALLBACK_COLOR;
  const classes = ['avatar', `avatar--${size}`, className].filter(Boolean).join(' ');

  return (
    <span
      className={classes}
      style={{ backgroundColor, color: readableTextColor(backgroundColor) }}
      role="img"
      aria-label={label}
      title={title ?? label}
    >
      {pickInitials(label)}
    </span>
  );
}
