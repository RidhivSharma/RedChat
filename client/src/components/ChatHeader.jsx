import Avatar from './Avatar.jsx';
import { ArrowLeftIcon, BellIcon, BellOffIcon, LockIcon, UsersIcon } from './icons.jsx';
import { conversationAvatar, conversationTitle, otherMember } from '../utils/conversations.js';
import { formatLastSeen } from '../utils/time.js';

function typingLabel(typingUserIds, conversation) {
  const names = typingUserIds.map((id) => {
    const member = (conversation.members ?? []).find((entry) => entry.id === id);
    return member?.displayName || 'Someone';
  });

  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return 'Several people are typing…';
}

/**
 * Conversation header: back button (mobile only), avatar with an online dot,
 * name and a status line — "online", "last seen …", "N members" or
 * "Alex is typing…". Groups get a button that opens the info panel. The lock
 * chip states that the conversation is end-to-end encrypted and opens the
 * "Verify encryption" dialog. The bell mutes desktop notifications for this
 * conversation only (a browser-local preference).
 */
export default function ChatHeader({
  conversation,
  currentUserId,
  presence,
  typingUserIds,
  isMuted = false,
  onToggleMute,
  onBack,
  onShowGroupInfo,
  onVerifyEncryption,
}) {
  const title = conversationTitle(conversation, currentUserId);
  const avatar = conversationAvatar(conversation, currentUserId);
  const isDirect = conversation.type === 'direct';
  const other = isDirect ? otherMember(conversation, currentUserId) : null;
  const online = Boolean(other && presence[other.id]?.online);

  let statusText;
  let statusClass = 'chat-panel__status';

  if (typingUserIds.length > 0) {
    statusText = typingLabel(typingUserIds, conversation);
    statusClass += ' chat-panel__status--typing';
  } else if (!isDirect) {
    const count = conversation.members?.length ?? 0;
    statusText = `${count} member${count === 1 ? '' : 's'}`;
  } else if (online) {
    statusText = 'online';
    statusClass += ' chat-panel__status--online';
  } else {
    statusText = formatLastSeen(presence[other?.id]?.lastSeen ?? other?.lastSeen);
  }

  return (
    <header className="chat-panel__header">
      <button
        type="button"
        className="btn btn--ghost btn--icon chat-back"
        onClick={onBack}
        aria-label="Back to conversations"
      >
        <ArrowLeftIcon size={18} />
      </button>

      <span className="avatar-wrap">
        <Avatar {...avatar} size="md" />
        {online && isDirect ? (
          <span className="presence-dot" role="img" aria-label="Online" title="Online" />
        ) : null}
      </span>

      <div className="chat-panel__user">
        <span className="chat-panel__user-name">{title}</span>
        <span className={statusClass} aria-live="polite">
          {statusText}
        </span>
      </div>

      <div className="chat-panel__actions">
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={onToggleMute}
          title={
            isMuted
              ? 'Notifications muted for this conversation — click to unmute'
              : 'Mute notifications for this conversation'
          }
          aria-pressed={isMuted}
          aria-label={isMuted ? 'Unmute notifications' : 'Mute notifications'}
        >
          {isMuted ? <BellOffIcon size={18} /> : <BellIcon size={18} />}
        </button>

        <button
          type="button"
          className="encryption-chip"
          onClick={onVerifyEncryption}
          aria-label="Messages are end-to-end encrypted. Verify encryption."
          title="Messages are end-to-end encrypted. Click to verify."
        >
          <LockIcon size={13} />
          <span className="encryption-chip__text">Messages are end-to-end encrypted</span>
          <span className="encryption-chip__link">Verify</span>
        </button>

        {!isDirect ? (
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={onShowGroupInfo}
            title="Group info"
            aria-label="Group info"
          >
            <UsersIcon size={18} />
          </button>
        ) : null}
      </div>
    </header>
  );
}
