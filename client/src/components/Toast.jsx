import { AlertIcon, CheckIcon, InfoIcon, XIcon } from './icons.jsx';

const ICONS = {
  success: CheckIcon,
  error: AlertIcon,
  info: InfoIcon,
};

/**
 * A single toast card. Rendered by ToastProvider inside .toast-viewport.
 */
export default function Toast({ toast, onDismiss }) {
  const { id, message, type = 'info' } = toast;
  const ToastIcon = ICONS[type] ?? ICONS.info;

  return (
    <div className={`toast toast--${type}`} role={type === 'error' ? 'alert' : 'status'}>
      <span className="toast__icon">
        <ToastIcon size={18} />
      </span>
      <p className="toast__message">{message}</p>
      <button
        type="button"
        className="toast__close"
        onClick={() => onDismiss(id)}
        aria-label="Dismiss notification"
      >
        <XIcon size={16} />
      </button>
    </div>
  );
}
