import { useState } from 'react';
import Avatar from './Avatar.jsx';
import BrandLogo from './BrandLogo.jsx';
import ConversationList from './ConversationList.jsx';
import NewGroupDialog from './NewGroupDialog.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import UserSearchResults from './UserSearchResults.jsx';
import { InfoIcon, LogoutIcon, PlusIcon, SearchIcon, XIcon } from './icons.jsx';
import { useChat } from '../hooks/useChat.js';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import { useTheme } from '../hooks/useTheme.js';

/**
 * Left rail: brand + theme/logout, the debounced user search (300 ms), the
 * "New group" button (opens the group builder) and the conversation list with
 * its loading / empty / error states.
 */
export default function Sidebar({ user, onSelectConversation, onLogout }) {
  const { theme, toggleTheme } = useTheme();
  const {
    conversations,
    conversationsStatus,
    conversationsError,
    messagesByConversation,
    presence,
    typingByConversation,
    activeConversationId,
    removedNotice,
    dismissRemovedNotice,
    refreshConversations,
    startDirectConversation,
    keyStatus,
  } = useChat();

  const [query, setQuery] = useState('');
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const trimmedQuery = query.trim();
  const debouncedQuery = useDebouncedValue(trimmedQuery, 300);
  const searchActive = trimmedQuery.length > 0;
  const searchPending = searchActive && debouncedQuery !== trimmedQuery;

  async function handleStartConversation(searchUser) {
    const conversation = await startDirectConversation(searchUser.id);
    setQuery('');
    onSelectConversation(conversation.id);
  }

  return (
    <aside className="chat-sidebar" aria-label="Conversations">
      <header className="chat-sidebar__header">
        <BrandLogo size={30} />
        <span className="chat-sidebar__brand">ChatWave</span>
        <div className="chat-sidebar__header-actions">
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <div className="chat-sidebar__search">
        <div className="chat-search">
          <div className="chat-search__field">
            <SearchIcon size={16} className="chat-search__icon" />
            <input
              className="input"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search people"
              aria-label="Search people by username or display name"
              autoComplete="off"
            />
            {searchActive ? (
              <button
                type="button"
                className="chat-search__clear"
                onClick={() => setQuery('')}
                aria-label="Clear search"
              >
                <XIcon size={14} />
              </button>
            ) : null}
          </div>

          <button
            type="button"
            className="btn btn--icon btn--sm chat-search__group"
            onClick={() => setGroupDialogOpen(true)}
            title="New group"
            aria-label="New group"
          >
            <PlusIcon size={18} />
          </button>
        </div>
      </div>

      {removedNotice ? (
        <div className="sidebar-notice" role="status">
          <InfoIcon size={16} className="sidebar-notice__icon" />
          <span className="sidebar-notice__text">
            {removedNotice.name
              ? `You are no longer a member of “${removedNotice.name}”.`
              : 'You are no longer a member of that group.'}
          </span>
          <button
            type="button"
            className="sidebar-notice__close"
            onClick={dismissRemovedNotice}
            aria-label="Dismiss notice"
          >
            <XIcon size={14} />
          </button>
        </div>
      ) : null}

      <div className="chat-sidebar__list">
        {searchActive ? (
          <UserSearchResults
            query={debouncedQuery}
            pending={searchPending}
            onStartConversation={handleStartConversation}
          />
        ) : (
          <ConversationList
            conversations={conversations}
            messages={messagesByConversation}
            status={conversationsStatus}
            error={conversationsError}
            currentUserId={user?.id}
            activeConversationId={activeConversationId}
            presence={presence}
            typingByConversation={typingByConversation}
            onSelect={onSelectConversation}
            onRetry={() => refreshConversations()}
          />
        )}
      </div>

      <footer className="chat-sidebar__footer">
        <div className="sidebar-user">
          <Avatar user={user} size="sm" />
          <div className="sidebar-user__info">
            <span className="sidebar-user__name">{user?.displayName}</span>
            <span className="sidebar-user__username">@{user?.username}</span>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--icon btn--sm"
            onClick={onLogout}
            title="Log out"
            aria-label="Log out"
          >
            <LogoutIcon size={18} />
          </button>
        </div>
        <p className="sidebar-note">
          {keyStatus === 'unavailable'
            ? '🔒 Encryption keys are unavailable on this device — sending is disabled.'
            : '🔒 Messages are end-to-end encrypted. ChatWave cannot read them.'}
        </p>
      </footer>

      <NewGroupDialog
        open={groupDialogOpen}
        onClose={() => setGroupDialogOpen(false)}
        onCreated={(conversationId) => {
          setGroupDialogOpen(false);
          onSelectConversation(conversationId);
        }}
      />
    </aside>
  );
}
