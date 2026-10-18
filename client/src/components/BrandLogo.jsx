/**
 * RedChat brand mark — a teal/indigo chat bubble with a wave inside.
 * Purely decorative; the surrounding UI carries the accessible name.
 */
export default function BrandLogo({ size = 32, className = '' }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="RedChat"
      focusable="false"
    >
      <defs>
        <linearGradient
          id="redchat-logo-gradient"
          x1="6"
          y1="8"
          x2="58"
          y2="58"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#14b8a6" />
          <stop offset="100%" stopColor="#4f46e5" />
        </linearGradient>
      </defs>
      <rect x="6" y="8" width="52" height="42" rx="14" fill="url(#redchat-logo-gradient)" />
      <path d="M20 48 12 58 32 50Z" fill="url(#redchat-logo-gradient)" />
      <path
        d="M19 33c3.5-7 7-7 10.5 0s7 7 10.5 0"
        fill="none"
        stroke="#ffffff"
        strokeWidth="4.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
