import { useEffect, useState } from 'react';
import Avatar from './Avatar.jsx';
import { AlertIcon, ChatBubbleIcon, RefreshIcon } from './icons.jsx';
import { usersApi } from '../services/api.js';
import { useToast } from '../hooks/useToast.js';

/**
 * Debounced user search (the 300 ms debounce lives in the Sidebar through
 * useDebouncedValue). Clicking a result starts — or reopens — the direct
 * conversation and opens it.
 */
export default function UserSearchResults({ query, pending, onStartConversation }) {
  const [state, setState] = useState({ status: 'idle', users: [], error: null });
  const [startingId, setStartingId] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const { showToast } = useToast();

  useEffect(() => {
    if (!query) {
      setState({ status: 'idle', users: [], error: null });
      return undefined;
    }

    const controller = new AbortController();
    setState({ status: 'loading', users: [], error: null });

    usersApi
      .search(query, { signal: controller.signal })
      .then((data) => setState({ status: 'ready', users: data?.users ?? [], error: null }))
      .catch((error) => {
        if (error?.name === 'AbortError') return;
        setState({ status: 'error', users: [], error });
      });

    return () => controller.abort();
  }, [query, reloadToken]);

  async function handleSelect(user) {
    if (startingId) return;
    setStartingId(user.id);
    try {
      await onStartConversation(user);
    } catch (error) {
      showToast(error?.message || 'Could not start the conversation.', 'error');
    } finally {
      setStartingId(null);
    }
  }

  if (pending || state.status === 'loading') {
    return (
      <div className="user-list" role="status" aria-label="Searching users">
        {[0, 1, 2].map((row) => (
          <div className="user-row user-row--skeleton" key={row} aria-hidden="true">
            <span className="skeleton skeleton--avatar" />
            <span className="user-row__info">
              <span className="skeleton skeleton--text conversation-skeleton__line" />
              <span className="skeleton skeleton--text conversation-skeleton__line conversation-skeleton__line--short" />
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="sidebar-state" role="alert">
        <AlertIcon size={24} className="sidebar-state__icon" />
        <p>{state.error?.message || 'User search failed.'}</p>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => setReloadToken((token) => token + 1)}
        >
          <RefreshIcon size={15} />
          Retry
        </button>
      </div>
    );
  }

  if (state.users.length === 0) {
    return (
      <div className="sidebar-state">
        <ChatBubbleIcon size={24} className="sidebar-state__icon sidebar-state__icon--muted" />
        <p>No users match “{query}”.</p>
        <p className="sidebar-state__hint">Try a username or display name.</p>
      </div>
    );
  }

  return (
    <ul className="user-list">
      {state.users.map((user) => (
        <li key={user.id}>
          <button
            type="button"
            className="user-row"
            onClick={() => handleSelect(user)}
            disabled={startingId === user.id}
          >
            <Avatar user={user} size="md" />
            <span className="user-row__info">
              <span className="user-row__name">{user.displayName}</span>
              <span className="user-row__handle">@{user.username}</span>
            </span>
            {startingId === user.id ? (
              <span className="spinner spinner--sm" aria-hidden="true" />
            ) : (
              <span className="badge badge--primary">Chat</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
