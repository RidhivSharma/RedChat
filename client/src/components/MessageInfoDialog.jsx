import { useEffect, useRef } from 'react';
import Avatar from './Avatar.jsx';
import { XIcon } from './icons.jsx';
import { receiptDetails } from '../utils/receipts.js';
import { formatDateTime } from '../utils/time.js';

function ReceiptSection({ title, entries, timeKey, emptyLabel }) {
  const count = entries.filter((entry) => entry[timeKey]).length;

  return (
    <section className="info-section">
      <h3 className="info-section__title">
        {title} {count} of {entries.length}
      </h3>

      {entries.length === 0 ? (
        <p className="info-section__empty">{emptyLabel}</p>
      ) : (
        <ul className="info-list">
          {entries.map((entry) => {
            const at = entry[timeKey];
            return (
              <li className="info-row" key={entry.user.id}>
                <Avatar user={entry.user} size="sm" />
                <span className="info-row__name">{entry.user.displayName}</span>
                <span className={`info-row__time${at ? '' : ' info-row__time--pending'}`}>
                  {at ? formatDateTime(at) : 'Pending'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * "Message info" for one own message: who delivered and who read it, with the
 * exact times (per member — the group tick only turns once everyone has).
 * Opened from the tick button; Escape and the backdrop close it.
 */
export default function MessageInfoDialog({ open, message, conversation, currentUserId, onClose }) {
  const closeRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose();
    }

    document.addEventListener('keydown', handleKeyDown);
    const focusTimer = setTimeout(() => closeRef.current?.focus(), 0);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      clearTimeout(focusTimer);
    };
  }, [open, onClose]);

  if (!open || !message || !conversation) return null;

  const entries = receiptDetails(message, conversation, currentUserId);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="message-info-title">
        <header className="modal__header">
          <h2 className="modal__title" id="message-info-title">
            Message info
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={onClose}
            aria-label="Close message info"
          >
            <XIcon size={18} />
          </button>
        </header>

        <div className="modal__body">
          <p className="modal__text">
            {message.deleted
              ? 'This message was deleted.'
              : message.text
                ? `“${message.text.length > 140 ? `${message.text.slice(0, 140)}…` : message.text}”`
                : 'Encrypted message'}
          </p>
          <p className="modal__text info-sent">Sent {formatDateTime(message.createdAt)}</p>

          <ReceiptSection
            title="Delivered to"
            entries={entries}
            timeKey="deliveredAt"
            emptyLabel="No other members."
          />
          <ReceiptSection
            title="Read by"
            entries={entries}
            timeKey="readAt"
            emptyLabel="No other members."
          />
        </div>

        <footer className="modal__footer">
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
