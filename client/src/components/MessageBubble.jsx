import Avatar from './Avatar.jsx';
import {
  AlertIcon,
  ClockIcon,
  DoubleTickIcon,
  LockIcon,
  RefreshIcon,
  TickIcon,
  TrashIcon,
} from './icons.jsx';
import { useAuth } from '../hooks/useAuth.js';
import { useDecryptedText } from '../hooks/useDecryptedText.js';
import { DECRYPTION_FAILED_MESSAGE } from '../utils/crypto/index.js';
import { formatTime } from '../utils/time.js';

/**
 * Own messages carry their delivery state right in the bubble:
 *   sending → clock, failed → alert, sent → one tick, delivered → two ticks,
 *   read → two blue ticks. Clicking the ticks opens the "Message info" view.
 */
function StatusIcon({ status, receipt, receiptLabel, onShowInfo }) {
  if (status === 'sending') {
    return (
      <>
        <ClockIcon size={12} className="bubble__status bubble__status--pending" />
        <span className="visually-hidden">Sending…</span>
      </>
    );
  }
  if (status === 'failed') {
    return (
      <>
        <AlertIcon size={12} className="bubble__status bubble__status--failed" />
        <span className="visually-hidden">Not sent</span>
      </>
    );
  }

  const read = receipt === 'read';
  const delivered = receipt === 'delivered';
  const label = receiptLabel || (read ? 'Read' : delivered ? 'Delivered' : 'Sent');

  return (
    <button
      type="button"
      className={`bubble__receipt${read ? ' bubble__receipt--read' : ''}`}
      onClick={() => onShowInfo?.()}
      title={label}
      aria-label={`${label}. Show message info`}
    >
      {delivered || read ? <DoubleTickIcon size={16} /> : <TickIcon size={14} />}
    </button>
  );
}

/**
 * One message bubble. `grouped` means the previous message shares the sender
 * and the 5-minute window (tighter corners, no repeated name/avatar).
 * The displayed text comes from useDecryptedText — the bubble only ever sees
 * ciphertext plus the key from the auth context.
 */
export default function MessageBubble({
  message,
  conversation,
  currentUserId,
  isOwn,
  grouped,
  showAvatar,
  showSenderName,
  senderUser,
  senderName,
  senderColor,
  receipt,
  receiptLabel,
  onShowInfo,
  onRetry,
  onRequestDelete,
}) {
  const { privateKey } = useAuth();
  const text = useDecryptedText(conversation, privateKey, currentUserId, message);

  const deleted = message.deleted;
  const failed = message.status === 'failed';
  const deletedLabel = isOwn ? 'You deleted this message' : 'This message was deleted';
  const canDelete = isOwn && Boolean(message.id) && !deleted && message.status === 'sent';
  const undecryptable = text === DECRYPTION_FAILED_MESSAGE;

  return (
    <div className={`message-row${isOwn ? ' message-row--own' : ''}`}>
      <span className="message-row__gutter">
        {showAvatar ? <Avatar user={senderUser} name={senderName} size="sm" /> : null}
      </span>

      <div className="message-col">
        {showSenderName ? (
          <span
            className="message-sender"
            style={senderColor ? { color: senderColor } : undefined}
          >
            {senderName}
          </span>
        ) : null}

        <div
          className={`bubble ${isOwn ? 'bubble--own' : 'bubble--other'}${
            grouped ? ' bubble--grouped' : ''
          }${deleted ? ' bubble--deleted' : ''}`}
        >
          {deleted ? (
            <span className="bubble__text bubble__text--deleted">{deletedLabel}</span>
          ) : text === null ? (
            <span className="bubble__text bubble__text--pending">
              <LockIcon size={12} /> Decrypting…
            </span>
          ) : (
            <span
              className={`bubble__text${undecryptable ? ' bubble__text--failed' : ''}`}
              title={undecryptable ? 'The key for this message is missing on this device' : undefined}
            >
              {text}
            </span>
          )}

          <span className="bubble__meta">
            <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
            {isOwn && !deleted ? (
              <StatusIcon
                status={message.status}
                receipt={receipt}
                receiptLabel={receiptLabel}
                onShowInfo={() => onShowInfo?.(message)}
              />
            ) : null}
          </span>
        </div>

        {failed ? (
          <div className="message-failed" role="alert">
            <AlertIcon size={14} />
            <span>{message.error || 'Not sent'}</span>
            <button type="button" className="message-failed__retry" onClick={() => onRetry(message)}>
              <RefreshIcon size={13} />
              Retry
            </button>
          </div>
        ) : null}

        {canDelete ? (
          <button
            type="button"
            className="message-actions"
            onClick={() => onRequestDelete(message)}
            title="Delete for everyone"
            aria-label="Delete message for everyone"
          >
            <TrashIcon size={14} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
