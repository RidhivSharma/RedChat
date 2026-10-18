import { useEffect, useRef, useState } from 'react';
import Avatar from './Avatar.jsx';
import { AlertIcon, LockIcon, XIcon } from './icons.jsx';
import { useAuth } from '../hooks/useAuth.js';
import { fingerprintOf, keyFingerprint } from '../utils/crypto/index.js';

/**
 * "Verify encryption" dialog.
 *
 * Direct chats: the SHA-256 fingerprint of BOTH public keys, sorted — both
 * sides compute the same string, so comparing it out of band (in person, over
 * a call) proves no one swapped keys in the middle.
 *
 * Groups: the group key (version N) is wrapped individually for each member;
 * every member is listed with the fingerprint of their own public key, so
 * members can verify each other pairwise.
 */
export default function EncryptionInfoDialog({ open, conversation, currentUserId, onClose }) {
  const { user } = useAuth();
  const closeRef = useRef(null);
  const [state, setState] = useState({ status: 'idle', fingerprint: null, members: [], error: null });

  const isGroup = conversation?.type === 'group';
  const other = !isGroup
    ? (conversation?.members ?? []).find((member) => member.id !== currentUserId) ?? null
    : null;

  // Escape closes the dialog (same pattern as the other modals).
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

  // Compute the fingerprint(s) whenever the dialog opens (or keys change).
  useEffect(() => {
    if (!open || !conversation) return undefined;

    let cancelled = false;
    setState({ status: 'loading', fingerprint: null, members: [], error: null });

    (async () => {
      try {
        const myPublicKey = user?.publicKey;
        if (!myPublicKey) {
          throw new Error('Your own encryption key is not available on this device.');
        }

        if (conversation.type === 'group') {
          const members = [];
          for (const member of conversation.members ?? []) {
            members.push({
              member,
              fingerprint: member.publicKey ? await fingerprintOf(member.publicKey) : null,
            });
          }
          if (!cancelled) {
            setState({
              status: 'ready',
              fingerprint: null,
              members,
              error: null,
            });
          }
          return;
        }

        if (!other?.publicKey) {
          throw new Error(
            `${other?.displayName || 'This user'} has not set up encryption keys yet.`
          );
        }

        const fingerprint = await keyFingerprint(myPublicKey, other.publicKey);
        if (!cancelled) {
          setState({ status: 'ready', fingerprint, members: [], error: null });
        }
      } catch (error) {
        if (!cancelled) {
          setState({ status: 'error', fingerprint: null, members: [], error });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, conversation, user?.publicKey, other?.id, other?.publicKey]);

  if (!open || !conversation) return null;

  const version = conversation.currentKeyVersion ?? 1;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="encryption-title">
        <header className="modal__header">
          <h2 className="modal__title" id="encryption-title">
            <LockIcon size={18} />
            Verify encryption
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={onClose}
            aria-label="Close encryption details"
          >
            <XIcon size={18} />
          </button>
        </header>

        <div className="modal__body encryption-info">
          <p className="modal__text">
            This conversation is encrypted in your browser before anything is sent. The server
            only stores ciphertext and cannot read your messages.
          </p>

          {state.status === 'loading' ? (
            <div className="messages-state messages-state--inline" role="status">
              <span className="spinner spinner--sm" aria-hidden="true" />
              <span>Computing fingerprint…</span>
            </div>
          ) : null}

          {state.status === 'error' ? (
            <p className="form-error" role="alert">
              <AlertIcon size={18} className="form-error__icon" />
              <span>{state.error?.message || 'Could not compute the fingerprint.'}</span>
            </p>
          ) : null}

          {state.status === 'ready' && !isGroup ? (
            <>
              <p className="modal__text">
                Compare this fingerprint with{' '}
                <strong>{other?.displayName || 'your contact'}</strong> over a channel you trust
                (in person, on a call). If both match, nobody — not even ChatWave — is in the
                middle of this conversation.
              </p>
              <code className="fingerprint">{state.fingerprint}</code>
            </>
          ) : null}

          {state.status === 'ready' && isGroup ? (
            <>
              <p className="modal__text">
                Messages in this group are encrypted with a shared group key (currently{' '}
                <strong>version {version}</strong>), wrapped individually for every member. When
                a member is removed or leaves, a new version is created and they lose access to
                future messages.
              </p>
              <p className="modal__text">
                Compare a member's fingerprint with them directly to verify their key.
              </p>
              <ul className="info-list">
                {state.members.map(({ member, fingerprint }) => (
                  <li className="info-row encryption-member" key={member.id}>
                    <Avatar user={member} size="sm" />
                    <span className="encryption-member__name">
                      {member.displayName}
                      {member.id === currentUserId ? ' (you)' : ''}
                    </span>
                    {fingerprint ? (
                      <code className="fingerprint fingerprint--compact">{fingerprint}</code>
                    ) : (
                      <span className="encryption-member__missing">No key yet</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
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
