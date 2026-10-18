import Avatar from './Avatar.jsx';
import EmptyState from './EmptyState.jsx';
import { AlertIcon, ChatBubbleIcon, RefreshIcon } from './icons.jsx';
import { useAuth } from '../hooks/useAuth.js';
import { useDecryptedText } from '../hooks/useDecryptedText.js';
import { fromServerMessage } from '../utils/messages.js';
import {
  conversationAvatar,
  conversationSubtitle,
  conversationTitle,
  otherMember,
} from '../utils/conversations.js';
import { formatConversationTime } from '../utils/time.js';

/**
 * The conversation's last message for the preview: the newest locally-known
 * message when there is one, otherwise the envelope the server sent with the
 * conversation (the client decrypts it — the server never stores previews).
 * Both are normalized through the same fromServerMessage() shape, so the
 * preview keeps `ciphertext` + `iv` and decrypts exactly like a bubble.
 */
function lastMessageOf(conversation, messages) {
  const list = messages?.[conversation.id] ?? [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message.id || message.clientId) return message;
  }

  if (!conversation.lastMessage) return null;
  return fromServerMessage(conversation.lastMessage);
}

/** Decrypted preview line (own sends are prefixed "You:", groups by name). */
function ConversationPreview({ conversation, message, currentUserId, fallback }) {
  const { privateKey } = useAuth();
  const text = useDecryptedText(conversation, privateKey, currentUserId, message);

  if (!message) return <>{fallback || 'No messages yet'}</>;
  if (message.deleted) return <>This message was deleted</>;
  if (message.type === 'system') return <>{message.text ?? 'Group updated'}</>;

  const own = message.sender === currentUserId;
  let prefix = '';
  if (own) {
    prefix = 'You: ';
  } else if (conversation.type === 'group') {
    const sender = (conversation.members ?? []).find((member) => member.id === message.sender);
    prefix = `${sender?.displayName || 'Someone'}: `;
  }

  return (
    <>
      {prefix}
      {text === null ? '…' : text}
    </>
  );
}

function ConversationItem({
  conversation,
  messages,
  currentUserId,
  active,
  online,
  typing,
  onSelect,
}) {
  const title = conversationTitle(conversation, currentUserId);
  const subtitle = conversationSubtitle(conversation, currentUserId);
  const avatar = conversationAvatar(conversation, currentUserId);
  const unread = conversation.unreadCount ?? 0;
  const lastMessage = lastMessageOf(conversation, messages);

  return (
    <li>
      <button
        type="button"
        className={`conversation-item${active ? ' conversation-item--active' : ''}`}
        onClick={() => onSelect(conversation.id)}
        aria-current={active ? 'true' : undefined}
      >
        <span className="avatar-wrap">
          <Avatar {...avatar} size="md" />
          {online ? <span className="presence-dot" role="img" aria-label="Online" title="Online" /> : null}
        </span>

        <span className="conversation-item__body">
          <span className="conversation-item__row">
            <span className="conversation-item__name">{title}</span>
            {conversation.lastMessageAt ? (
              <time className="conversation-item__time" dateTime={conversation.lastMessageAt}>
                {formatConversationTime(conversation.lastMessageAt)}
              </time>
            ) : null}
          </span>

          <span className="conversation-item__row">
            <span
              className={`conversation-item__preview${
                typing ? ' conversation-item__preview--typing' : ''
              }`}
            >
              {typing ? (
                'typing…'
              ) : (
                <ConversationPreview
                  conversation={conversation}
                  message={lastMessage}
                  currentUserId={currentUserId}
                  fallback={subtitle}
                />
              )}
            </span>
            {unread > 0 ? (
              <span
                className="unread-badge"
                aria-label={`${unread} unread message${unread === 1 ? '' : 's'}`}
              >
                {unread > 99 ? '99+' : unread}
              </span>
            ) : null}
          </span>
        </span>
      </button>
    </li>
  );
}

function ConversationListSkeleton() {
  return (
    <div className="conversation-list" role="status" aria-label="Loading conversations">
      {[0, 1, 2, 3, 4].map((row) => (
        <div className="conversation-item conversation-item--skeleton" key={row} aria-hidden="true">
          <span className="skeleton skeleton--avatar" />
          <span className="conversation-item__body">
            <span className="skeleton skeleton--text conversation-skeleton__line" />
            <span className="skeleton skeleton--text conversation-skeleton__line conversation-skeleton__line--short" />
          </span>
        </div>
      ))}
    </div>
  );
}

function RetryableError({ message, onRetry }) {
  return (
    <div className="sidebar-state" role="alert">
      <AlertIcon size={24} className="sidebar-state__icon" />
      <p>{message}</p>
      <button type="button" className="btn btn--sm" onClick={onRetry}>
        <RefreshIcon size={15} />
        Retry
      </button>
    </div>
  );
}

/**
 * The conversation list with its loading (skeleton), empty and error states.
 * Direct chats are titled by the other member; a green dot marks them online.
 * The preview line is decrypted locally from the last message envelope.
 */
export default function ConversationList({
  conversations,
  messages,
  status,
  error,
  currentUserId,
  activeConversationId,
  presence,
  typingByConversation,
  onSelect,
  onRetry,
}) {
  if (conversations.length === 0) {
    if (status === 'loading' || status === 'idle') return <ConversationListSkeleton />;
    if (status === 'error') {
      return (
        <RetryableError
          message={error?.message || 'Could not load your conversations.'}
          onRetry={onRetry}
        />
      );
    }
    return (
      <EmptyState
        icon={<ChatBubbleIcon size={28} />}
        title="No conversations yet"
        description="Search for someone above to start your first chat."
      />
    );
  }

  return (
    <>
      {status === 'error' && error ? (
        <div className="sidebar-state sidebar-state--inline" role="alert">
          <p>{error.message || 'Could not refresh your conversations.'}</p>
          <button type="button" className="btn btn--sm" onClick={onRetry}>
            <RefreshIcon size={15} />
            Retry
          </button>
        </div>
      ) : null}

      <ul className="conversation-list">
        {conversations.map((conversation) => {
          const other = conversation.type === 'direct' ? otherMember(conversation, currentUserId) : null;
          return (
            <ConversationItem
              key={conversation.id}
              conversation={conversation}
              messages={messages}
              currentUserId={currentUserId}
              active={conversation.id === activeConversationId}
              online={Boolean(other && presence[other.id]?.online)}
              typing={Object.keys(typingByConversation[conversation.id] ?? {}).length > 0}
              onSelect={onSelect}
            />
          );
        })}
      </ul>
    </>
  );
}
