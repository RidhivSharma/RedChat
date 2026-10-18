import { useEffect, useState } from 'react';
import { useChat } from './useChat.js';
import {
  DECRYPTION_FAILED_MESSAGE,
  decryptForConversation,
  getRememberedMessagePlaintext,
} from '../utils/crypto/index.js';

/**
 * Resolves the display text of one message:
 *   - system lines / legacy plain-text rows come back verbatim,
 *   - encrypted rows are decrypted with the conversation key (device cache),
 *   - failures resolve to "Unable to decrypt this message".
 *
 * Returns `null` while the first decryption is still running (callers show a
 * pending state) — a cached plaintext (own sends, already-decrypted messages)
 * is returned synchronously so bubbles never flash.
 *
 * Passed through the crypto module's plaintext cache, so every bubble/preview
 * decrypts each envelope at most once per session.
 */
export function useDecryptedText(conversation, privateKey, currentUserId, message) {
  const { refreshConversationKeys } = useChat();
  const [text, setText] = useState(() => {
    if (!message || message.deleted) return null;
    if (message.type === 'system' || message.encrypted !== true) {
      return message.text ?? null;
    }
    const cached = getRememberedMessagePlaintext(conversation?.id, message);
    return cached !== undefined ? cached : null;
  });

  useEffect(() => {
    if (!message || !conversation || message.deleted) return undefined;

    // Plain rows need no key at all.
    if (message.type === 'system' || message.encrypted !== true) {
      setText(message.text ?? null);
      return undefined;
    }

    const cached = getRememberedMessagePlaintext(conversation.id, message);
    if (cached !== undefined) {
      setText(cached);
      return undefined;
    }

    let cancelled = false;
    decryptForConversation(conversation, privateKey, currentUserId, message).then((value) => {
      if (cancelled) return;
      setText(value);
      // A failure is often stale key material (a member published their key
      // after this conversation was cached): refetch it once (throttled); a
      // fresh conversation object re-runs this effect and retries.
      if (value === DECRYPTION_FAILED_MESSAGE) refreshConversationKeys(conversation.id);
    });

    return () => {
      cancelled = true;
    };
    // conversation identity changes when members/keys/currentKeyVersion change,
    // which is exactly when a previously failed decryption becomes possible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    conversation,
    privateKey,
    currentUserId,
    message?.id,
    message?.clientId,
    message?.text,
    message?.deleted,
  ]);

  return text;
}

export default useDecryptedText;
