import { useEffect, useMemo, useRef, useState } from 'react';
import Avatar from './Avatar.jsx';
import {
  AlertIcon,
  ChatBubbleIcon,
  CheckIcon,
  RefreshIcon,
  SearchIcon,
  UserPlusIcon,
  XIcon,
} from './icons.jsx';
import { usersApi } from '../services/api.js';
import { useChat } from '../hooks/useChat.js';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import { useToast } from '../hooks/useToast.js';

const MAX_NAME_LENGTH = 50;
/** The server requires at least 2 members besides the creator. */
const MIN_MEMBERS = 2;

function validateName(value) {
  const name = String(value ?? '').trim();
  if (!name) return 'Group name is required';
  if (name.length > MAX_NAME_LENGTH) {
    return `Group name must be at most ${MAX_NAME_LENGTH} characters`;
  }
  return null;
}

/**
 * "New group" modal: a name, a multi-select user search (selected people show
 * as chips) and a create button. Escape and a backdrop click close it.
 */
export default function NewGroupDialog({ open, onClose, onCreated }) {
  const { startGroupConversation } = useChat();
  const { showToast } = useToast();

  const [name, setName] = useState('');
  const [nameError, setNameError] = useState(null);
  const [members, setMembers] = useState([]);
  const [membersError, setMembersError] = useState(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState({ status: 'idle', users: [], error: null });
  const [reloadToken, setReloadToken] = useState(0);
  const [creating, setCreating] = useState(false);
  const nameRef = useRef(null);

  const trimmedQuery = query.trim();
  const debouncedQuery = useDebouncedValue(trimmedQuery, 300);
  const searchPending = trimmedQuery.length > 0 && debouncedQuery !== trimmedQuery;

  // A clean slate (and focus on the name) every time the dialog opens.
  useEffect(() => {
    if (!open) return undefined;

    setName('');
    setNameError(null);
    setMembers([]);
    setMembersError(null);
    setQuery('');
    setSearch({ status: 'idle', users: [], error: null });
    setCreating(false);

    const timer = setTimeout(() => nameRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);

  // Escape closes the dialog (never while the create request is in flight).
  useEffect(() => {
    if (!open) return undefined;

    function handleKeyDown(event) {
      if (event.key === 'Escape' && !creating) onClose();
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, creating, onClose]);

  // Debounced user search.
  useEffect(() => {
    if (!open || !debouncedQuery) {
      setSearch({ status: 'idle', users: [], error: null });
      return undefined;
    }

    const controller = new AbortController();
    setSearch({ status: 'loading', users: [], error: null });

    usersApi
      .search(debouncedQuery, { signal: controller.signal })
      .then((data) => setSearch({ status: 'ready', users: data?.users ?? [], error: null }))
      .catch((error) => {
        if (error?.name === 'AbortError') return;
        setSearch({ status: 'error', users: [], error });
      });

    return () => controller.abort();
  }, [open, debouncedQuery, reloadToken]);

  const selectedIds = useMemo(() => new Set(members.map((member) => member.id)), [members]);

  function toggleMember(user) {
    setMembersError(null);
    setMembers((current) =>
      current.some((member) => member.id === user.id)
        ? current.filter((member) => member.id !== user.id)
        : [...current, user]
    );
  }

  async function handleCreate(event) {
    event.preventDefault();
    if (creating) return;

    const invalidName = validateName(name);
    setNameError(invalidName);
    if (invalidName) return;

    if (members.length < MIN_MEMBERS) {
      setMembersError(`Pick at least ${MIN_MEMBERS} people to start a group.`);
      return;
    }

    setCreating(true);
    try {
      const conversation = await startGroupConversation(name.trim(), members);
      showToast(`Group “${conversation.name}” created.`, 'success');
      onCreated?.(conversation.id);
    } catch (error) {
      showToast(error?.message || 'Could not create the group.', 'error');
    } finally {
      setCreating(false);
    }
  }

  function renderSearchResults() {
    if (!trimmedQuery) {
      return (
        <div className="sidebar-state sidebar-state--inline">
          <UserPlusIcon size={22} className="sidebar-state__icon sidebar-state__icon--muted" />
          <p>Search for people to add to the group.</p>
        </div>
      );
    }

    if (searchPending || search.status === 'loading') {
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

    if (search.status === 'error') {
      return (
        <div className="sidebar-state sidebar-state--inline" role="alert">
          <AlertIcon size={22} className="sidebar-state__icon" />
          <p>{search.error?.message || 'User search failed.'}</p>
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

    if (search.users.length === 0) {
      return (
        <div className="sidebar-state sidebar-state--inline">
          <ChatBubbleIcon size={22} className="sidebar-state__icon sidebar-state__icon--muted" />
          <p>No users match “{trimmedQuery}”.</p>
        </div>
      );
    }

    return (
      <ul className="user-list">
        {search.users.map((user) => {
          const selected = selectedIds.has(user.id);
          return (
            <li key={user.id}>
              <button
                type="button"
                className={`user-row${selected ? ' user-row--selected' : ''}`}
                onClick={() => toggleMember(user)}
                aria-pressed={selected}
              >
                <Avatar user={user} size="md" />
                <span className="user-row__info">
                  <span className="user-row__name">{user.displayName}</span>
                  <span className="user-row__handle">@{user.username}</span>
                </span>
                {selected ? (
                  <span className="badge badge--success">
                    <CheckIcon size={13} />
                    Added
                  </span>
                ) : (
                  <span className="badge badge--primary">
                    <UserPlusIcon size={13} />
                    Add
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !creating) onClose();
      }}
    >
      <div
        className="modal modal--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-group-title"
      >
        <header className="modal__header">
          <h2 className="modal__title" id="new-group-title">
            New group
          </h2>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={onClose}
            disabled={creating}
            aria-label="Close dialog"
          >
            <XIcon size={18} />
          </button>
        </header>

        <form id="new-group-form" className="modal__body new-group" onSubmit={handleCreate} noValidate>
          <div className="field">
            <label className="field__label" htmlFor="new-group-name">
              Group name
            </label>
            <input
              id="new-group-name"
              ref={nameRef}
              className={`input${nameError ? ' input--invalid' : ''}`}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (nameError) setNameError(null);
              }}
              placeholder="Weekend crew"
              maxLength={MAX_NAME_LENGTH * 2}
              autoComplete="off"
              aria-invalid={Boolean(nameError)}
            />
            {nameError ? (
              <p className="field__error" role="alert">
                {nameError}
              </p>
            ) : null}
          </div>

          <div className="field">
            <span className="field__label">
              Members {members.length > 0 ? `(${members.length} selected)` : ''}
            </span>

            {members.length > 0 ? (
              <ul className="chip-list" aria-label="Selected members">
                {members.map((member) => (
                  <li key={member.id}>
                    <span className="chip">
                      <Avatar user={member} size="sm" />
                      <span className="chip__name">{member.displayName}</span>
                      <button
                        type="button"
                        className="chip__remove"
                        onClick={() => toggleMember(member)}
                        aria-label={`Remove ${member.displayName}`}
                      >
                        <XIcon size={12} />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="chat-search__field">
              <SearchIcon size={16} className="chat-search__icon" />
              <input
                className="input"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search people"
                aria-label="Search people to add"
                autoComplete="off"
              />
              {trimmedQuery ? (
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

            <div className="new-group__results">{renderSearchResults()}</div>

            {membersError ? (
              <p className="field__error" role="alert">
                {membersError}
              </p>
            ) : (
              <p className="field__hint">
                A group needs at least {MIN_MEMBERS} people besides you.
              </p>
            )}
          </div>
        </form>

        <footer className="modal__footer">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={creating}>
            Cancel
          </button>
          <button type="submit" form="new-group-form" className="btn btn--primary" disabled={creating}>
            {creating ? <span className="spinner spinner--sm" aria-hidden="true" /> : null}
            Create group
          </button>
        </footer>
      </div>
    </div>
  );
}
