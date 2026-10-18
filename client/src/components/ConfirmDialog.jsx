import { useEffect, useRef } from 'react';
import { XIcon } from './icons.jsx';

/**
 * Reusable confirmation modal (delete for everyone, destructive actions).
 * Escape and a backdrop click cancel; the confirm button takes focus.
 */
export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}) {
  const confirmRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    function handleKeyDown(event) {
      if (event.key === 'Escape' && !busy) onCancel();
    }

    document.addEventListener('keydown', handleKeyDown);
    const focusTimer = setTimeout(() => confirmRef.current?.focus(), 0);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      clearTimeout(focusTimer);
    };
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <header className="modal__header">
          <h2 className="modal__title" id="confirm-dialog-title">
            {title}
          </h2>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={onCancel}
            disabled={busy}
            aria-label="Close dialog"
          >
            <XIcon size={18} />
          </button>
        </header>

        <div className="modal__body">
          <p className="modal__text">{description}</p>
        </div>

        <footer className="modal__footer">
          <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <span className="spinner spinner--sm" aria-hidden="true" /> : null}
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
