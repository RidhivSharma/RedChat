import { useEffect, useMemo, useRef, useState } from 'react';
import Avatar from './Avatar.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';
import {
  AlertIcon,
  CheckIcon,
  PencilIcon,
  RefreshIcon,
  SearchIcon,
  UserPlusIcon,
  XIcon,
} from './icons.jsx';
import { usersApi } from '../services/api.js';
import { useChat } from '../hooks/useChat.js';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import { useToast } from '../hooks/useToast.js';
import { conversationAvatar, conversationTitle, isGroupAdmin } from '../utils/conversations.js';
import { formatLastSeen } from '../utils/time.js';

const MAX_NAME_LENGTH = 50;

/**
 * Group info slide-over: members with online status and admin badges, member
 * management for admins (add, promote, remove), rename and "Leave group".
 */
export default function GroupInfoPanel({ open, conversation, currentUserId, onClose, onLeft }) {
  const {
    presence,
    addGroupMembers,
    removeGroupMember,
    renameGroup,
    promoteGroupAdmin,
    leaveGroup,
  } = useChat();
  const { showToast } = useToast();

  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState({ status: 'idle', users: [], error: null });
  const [reloadToken, setReloadToken] = useState(0);
  const [busy, setBusy] = useState(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const closeRef = useRef(null);

  const conversationId = conversation?.id ?? null;
  const trimmedQuery = query.trim();
  const debouncedQuery = useDebouncedValue(trimmedQuery, 300);
  const searchPending = trimmedQuery.length > 0 && debouncedQuery !== trimmedQuery;

  const isAdmin = isGroupAdmin(conversation, currentUserId);
  const memberIds = useMemo(
    () => new Set((conversation?.members ?? []).map((member) => member.id)),
    [conversation]
  );
  const sortedMembers = useMemo(() => {
    const admins = new Set(conversation?.admins ?? []);
    return [...(conversation?.members ?? [])].sort((a, b) => {
      const adminDiff = Number(admins.has(b.id)) - Number(admins.has(a.id));
      if (adminDiff !== 0) return adminDiff;
      return (a.displayName || '').localeCompare(b.displayName || '');
    });
  }, [conversation]);

  // Fresh local state and focus whenever the panel (re)opens.
  useEffect(() => {
    if (!open) return undefined;

    setRenaming(false);
    setNameDraft(conversation?.name ?? '');
    setAdding(false);
    setQuery('');
    setSearch({ status: 'idle', users: [], error: null });
    setBusy(null);
    setConfirmLeave(false);

    const timer = setTimeout(() => closeRef.current?.focus(), 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, conversationId]);

  // Escape closes the panel (not while an action or confirmation is open).
  useEffect(() => {
    if (!open) return undefined;

    function handleKeyDown(event) {
      if (event.key === 'Escape' && !busy && !confirmLeave) onClose();
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, busy, confirmLeave, onClose]);

  // Debounced "add members" search.
  useEffect(() => {
    if (!open || !adding || !debouncedQuery) {
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
  }, [open, adding, debouncedQuery, reloadToken]);

  if (!open || !conversation) return null;

  const title = conversationTitle(conversation, currentUserId);
  const memberCount = conversation.members?.length ?? 0;

  async function handleRename(event) {
    event.preventDefault();
    const name = nameDraft.trim();
    if (!name) {
      showToast('Group name is required.', 'error');
      return;
    }
    if (name.length > MAX_NAME_LENGTH) {
      showToast(`Group name must be at most ${MAX_NAME_LENGTH} characters.`, 'error');
      return;
    }
    if (name === (conversation.name ?? '')) {
      setRenaming(false);
      return;
    }

    setBusy('rename');
    try {
      await renameGroup(conversation.id, name);
      setRenaming(false);
      showToast('Group renamed.', 'success');
    } catch (error) {
      showToast(error?.message || 'Could not rename the group.', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function handleAdd(user) {
    setBusy(`add:${user.id}`);
    try {
      await addGroupMembers(conversation.id, [user]);
      showToast(`${user.displayName} added to the group.`, 'success');
      setQuery('');
      setSearch({ status: 'idle', users: [], error: null });
    } catch (error) {
      showToast(error?.message || 'Could not add that person.', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove(member) {
    setBusy(`remove:${member.id}`);
    try {
      await removeGroupMember(conversation.id, member.id);
      showToast(`${member.displayName} was removed from the group.`, 'success');
    } catch (error) {
      showToast(error?.message || 'Could not remove that member.', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function handlePromote(member) {
    setBusy(`promote:${member.id}`);
    try {
      await promoteGroupAdmin(conversation.id, member.id);
      showToast(`${member.displayName} is now an admin.`, 'success');
    } catch (error) {
      showToast(error?.message || 'Could not promote that member.', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function handleLeave() {
    setBusy('leave');
    try {
      await leaveGroup(conversation.id);
      showToast('You left the group.', 'success');
      onLeft?.();
    } catch (error) {
      showToast(error?.message || 'Could not leave the group.', 'error');
      setBusy(null);
      setConfirmLeave(false);
    }
  }

  function renderMemberStatus(member) {
    const entry = presence[member.id];
    if (entry?.online) return 'Online';
    return formatLastSeen(entry?.lastSeen ?? member.lastSeen);
  }

  function renderMemberActions(member) {
    const isSelf = member.id === currentUserId;
    const admin = (conversation.admins ?? []).includes(member.id);
    if (!isAdmin || isSelf) return null;

    return (
      <span className="member-row__actions">
        {!admin ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm member-row__action"
            onClick={() => handlePromote(member)}
            disabled={busy !== null}
            title={`Make ${member.displayName} an admin`}
          >
            <CheckIcon size={14} />
            Admin
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn--ghost btn--icon btn--sm member-row__action member-row__action--danger"
          onClick={() => handleRemove(member)}
          disabled={busy !== null}
          title={`Remove ${member.displayName} from the group`}
          aria-label={`Remove ${member.displayName} from the group`}
        >
          <XIcon size={15} />
        </button>
      </span>
    );
  }

  function renderAddResults() {
    if (!trimmedQuery) {
      return (
        <p className="group-add__hint">
          Search for people to add. Only current non-members are shown.
        </p>
      );
    }

    if (searchPending || search.status === 'loading') {
      return (
        <div className="sidebar-state sidebar-state--inline" role="status">
          <span className="spinner spinner--sm" aria-hidden="true" />
          <p>Searching…</p>
        </div>
      );
    }

    if (search.status === 'error') {
      return (
        <div className="sidebar-state sidebar-state--inline" role="alert">
          <AlertIcon size={20} className="sidebar-state__icon" />
          <p>{search.error?.message || 'User search failed.'}</p>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => setReloadToken((token) => token + 1)}
          >
            <RefreshIcon size={14} />
            Retry
          </button>
        </div>
      );
    }

    const candidates = search.users.filter((user) => !memberIds.has(user.id));
    if (candidates.length === 0) {
      return (
        <p className="group-add__hint">
          {search.users.length > 0
            ? 'Everyone matching that search is already in the group.'
            : `No users match “${trimmedQuery}”.`}
        </p>
      );
    }

    return (
      <ul className="user-list">
        {candidates.map((user) => (
          <li key={user.id}>
            <div className="user-row user-row--static">
              <Avatar user={user} size="sm" />
              <span className="user-row__info">
                <span className="user-row__name">{user.displayName}</span>
                <span className="user-row__handle">@{user.username}</span>
              </span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => handleAdd(user)}
                disabled={busy !== null}
              >
                {busy === `add:${user.id}` ? (
                  <span className="spinner spinner--sm" aria-hidden="true" />
                ) : (
                  <UserPlusIcon size={14} />
                )}
                Add
              </button>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div
      className="panel-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy && !confirmLeave) onClose();
      }}
    >
      <aside className="group-panel" role="dialog" aria-modal="true" aria-label={`${title} — group info`}>
        <header className="group-panel__header">
          <h2 className="group-panel__title">Group info</h2>
          <button
            ref={closeRef}
            type="button"
            className="btn btn--ghost btn--icon btn--sm"
            onClick={onClose}
            aria-label="Close group info"
          >
            <XIcon size={18} />
          </button>
        </header>

        <div className="group-panel__body">
          <div className="group-panel__hero">
            <Avatar {...conversationAvatar(conversation, currentUserId)} size="lg" />

            {renaming ? (
              <form className="group-rename" onSubmit={handleRename}>
                <input
                  className="input"
                  value={nameDraft}
                  onChange={(event) => setNameDraft(event.target.value)}
                  maxLength={MAX_NAME_LENGTH}
                  aria-label="Group name"
                  autoFocus
                />
                <div className="group-rename__actions">
                  <button type="submit" className="btn btn--sm" disabled={busy === 'rename'}>
                    {busy === 'rename' ? (
                      <span className="spinner spinner--sm" aria-hidden="true" />
                    ) : null}
                    Save
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setRenaming(false)}
                    disabled={busy === 'rename'}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div className="group-panel__name-row">
                <span className="group-panel__name">{title}</span>
                {isAdmin ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon btn--sm"
                    onClick={() => {
                      setNameDraft(conversation.name ?? '');
                      setRenaming(true);
                    }}
                    title="Rename group"
                    aria-label="Rename group"
                  >
                    <PencilIcon size={15} />
                  </button>
                ) : null}
              </div>
            )}

            <p className="group-panel__meta">
              {memberCount} member{memberCount === 1 ? '' : 's'}
            </p>
          </div>

          <section className="group-panel__section">
            <div className="group-panel__section-head">
              <h3 className="group-panel__section-title">Members</h3>
              {isAdmin ? (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setAdding((value) => !value)}
                  aria-expanded={adding}
                >
                  <UserPlusIcon size={15} />
                  Add members
                </button>
              ) : null}
            </div>

            {adding ? (
              <div className="group-add">
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
                <div className="group-add__results">{renderAddResults()}</div>
              </div>
            ) : null}

            <ul className="member-list">
              {sortedMembers.map((member) => {
                const isSelf = member.id === currentUserId;
                const admin = (conversation.admins ?? []).includes(member.id);
                const online = Boolean(presence[member.id]?.online);

                return (
                  <li className={`member-row${isSelf ? ' member-row--me' : ''}`} key={member.id}>
                    <span className="avatar-wrap">
                      <Avatar user={member} size="sm" />
                      {online ? (
                        <span
                          className="presence-dot"
                          role="img"
                          aria-label={`${member.displayName} is online`}
                          title="Online"
                        />
                      ) : null}
                    </span>

                    <span className="member-row__info">
                      <span className="member-row__name">
                        {member.displayName}
                        {isSelf ? ' (you)' : ''}
                      </span>
                      <span className="member-row__status">{renderMemberStatus(member)}</span>
                    </span>

                    {admin ? <span className="badge badge--accent member-row__badge">Admin</span> : null}
                    {renderMemberActions(member)}
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="group-panel__section group-panel__section--danger">
            <button
              type="button"
              className="btn btn--danger btn--block"
              onClick={() => setConfirmLeave(true)}
              disabled={busy !== null}
            >
              Leave group
            </button>
          </section>
        </div>

        <ConfirmDialog
          open={confirmLeave}
          title="Leave group?"
          description={`You will stop receiving messages from “${title}”. You can only rejoin if an admin adds you again.`}
          confirmLabel="Leave group"
          danger
          busy={busy === 'leave'}
          onConfirm={handleLeave}
          onCancel={() => setConfirmLeave(false)}
        />
      </aside>
    </div>
  );
}
