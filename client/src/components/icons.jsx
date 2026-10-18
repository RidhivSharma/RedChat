// Small inline SVG icon set (currentColor, aria-hidden) — no icon libraries.

function Icon({ size = 18, className = '', strokeWidth = 1.8, children }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function CheckIcon(props) {
  return (
    <Icon {...props}>
      <path d="M5 12.5 10 17.5 19 7" />
    </Icon>
  );
}

/** Single "sent" tick for own message bubbles. */
export function TickIcon(props) {
  return (
    <Icon {...props} strokeWidth={2}>
      <path d="M5 12.5 9.5 17 19 7" />
    </Icon>
  );
}

/** Double "delivered" / "read" tick — recolored via CSS for read. */
export function DoubleTickIcon(props) {
  return (
    <Icon {...props} strokeWidth={2}>
      <path d="M1.8 13 6 17.2 15.4 7.4" />
      <path d="M9 13 13.2 17.2 22.2 7.6" />
    </Icon>
  );
}

export function AlertIcon(props) {
  return (
    <Icon {...props}>
      <path d="M12 3.6 2.9 19a1.4 1.4 0 0 0 1.2 2.1h15.8a1.4 1.4 0 0 0 1.2-2.1Z" />
      <path d="M12 9.5v4.2" />
      <path d="M12 17.2h.01" strokeWidth="2.2" />
    </Icon>
  );
}

export function InfoIcon(props) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" strokeWidth="2.2" />
    </Icon>
  );
}

export function XIcon(props) {
  return (
    <Icon {...props} strokeWidth={2}>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </Icon>
  );
}

export function EyeIcon(props) {
  return (
    <Icon {...props}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

export function EyeOffIcon(props) {
  return (
    <Icon {...props}>
      <path d="M2.5 12S6 5.5 12 5.5c1.3 0 2.5.3 3.6.8" />
      <path d="M21.5 12S18 18.5 12 18.5c-1.3 0-2.5-.3-3.6-.8" />
      <path d="M4.5 19.5 19.5 4.5" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

export function SunIcon(props) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
    </Icon>
  );
}

export function MoonIcon(props) {
  return (
    <Icon {...props}>
      <path d="M20.4 13.4A8.5 8.5 0 0 1 10.6 3.6a8.5 8.5 0 1 0 9.8 9.8Z" />
    </Icon>
  );
}

export function LogoutIcon(props) {
  return (
    <Icon {...props}>
      <path d="M14.5 4H18a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3.5" />
      <path d="M10 8 6 12l4 4" />
      <path d="M6 12h9" />
    </Icon>
  );
}

export function ChatBubbleIcon(props) {
  return (
    <Icon {...props}>
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4V16H6.5A2.5 2.5 0 0 1 4 13.5Z" />
    </Icon>
  );
}

export function SearchIcon(props) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </Icon>
  );
}

export function SendIcon(props) {
  return (
    <Icon {...props}>
      <path d="M4.5 12 20 4.5 12.5 20l-2.2-6.1L4.5 12Z" />
      <path d="m10.3 13.9 4.4-4.4" />
    </Icon>
  );
}

export function PlusIcon(props) {
  return (
    <Icon {...props} strokeWidth={2}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Icon>
  );
}

export function TrashIcon(props) {
  return (
    <Icon {...props}>
      <path d="M4 7h16" />
      <path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" />
      <path d="M6.5 7l.9 11.6A1.5 1.5 0 0 0 8.9 20h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
      <path d="M10.2 11v5.2M13.8 11v5.2" />
    </Icon>
  );
}

export function ArrowLeftIcon(props) {
  return (
    <Icon {...props}>
      <path d="M19 12H5" />
      <path d="m11 6-6 6 6 6" />
    </Icon>
  );
}

export function ArrowDownIcon(props) {
  return (
    <Icon {...props}>
      <path d="M12 5v14" />
      <path d="m6 13 6 6 6-6" />
    </Icon>
  );
}

export function RefreshIcon(props) {
  return (
    <Icon {...props}>
      <path d="M20 11.5a8 8 0 1 0-2.4 5.4" />
      <path d="M20 5.5V12h-6.3" />
    </Icon>
  );
}

export function UsersIcon(props) {
  return (
    <Icon {...props}>
      <circle cx="9" cy="8.5" r="3.5" />
      <path d="M2.8 19.6a6.4 6.4 0 0 1 12.4 0" />
      <path d="M16.4 5.3a3.5 3.5 0 0 1 0 6.4" />
      <path d="M18 14.3a6.4 6.4 0 0 1 3.2 5.3" />
    </Icon>
  );
}

/** "Add member" — a person with a plus. */
export function UserPlusIcon(props) {
  return (
    <Icon {...props}>
      <circle cx="10" cy="8.5" r="3.5" />
      <path d="M3.8 19.6a6.4 6.4 0 0 1 12.4 0" />
      <path d="M18.5 7.5v6" />
      <path d="M15.5 10.5h6" />
    </Icon>
  );
}

/** "Rename" — a pencil. */
export function PencilIcon(props) {
  return (
    <Icon {...props}>
      <path d="M4 20h4.2L20 8.2a2.1 2.1 0 0 0 0-3L18.8 4a2.1 2.1 0 0 0-3 0L4 15.8Z" />
      <path d="m14.5 5.5 4 4" />
    </Icon>
  );
}

export function WifiOffIcon(props) {
  return (
    <Icon {...props}>
      <path d="M3.2 8.9a15.5 15.5 0 0 1 4.4-2.4" />
      <path d="M12.6 5.4c3.2-.1 6.2 1.1 8.6 3.1" />
      <path d="M5.6 12.6a11.5 11.5 0 0 1 2.7-1.4" />
      <path d="M14 10.9c1.7.2 3.3.8 4.7 1.7" />
      <path d="M9.7 15.7a6.8 6.8 0 0 1 4.6 0" />
      <path d="M12 19.3h.01" strokeWidth="2.4" />
      <path d="M4 3.6 20.2 20" />
    </Icon>
  );
}

export function ClockIcon(props) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.4V12l3 1.8" />
    </Icon>
  );
}

/** Padlock — the end-to-end encryption markers (header chip, unlock screen). */
export function LockIcon(props) {
  return (
    <Icon {...props}>
      <rect x="4.5" y="10.3" width="15" height="10.2" rx="2.2" />
      <path d="M8 10.3V8a4 4 0 0 1 8 0v2.3" />
      <path d="M12 14.4v2.3" strokeWidth="2.2" />
    </Icon>
  );
}
