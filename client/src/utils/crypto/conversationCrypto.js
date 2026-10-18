// ============================================================================
// Conversation-level crypto orchestration.
//
// Ties the primitive modules together and answers the two questions the chat
// layer has:
//   - "what key encrypts this conversation?"      getConversationEncryptionKey()
//   - "what text is inside this message?"         decryptForConversation()
//
// Key caches (in memory, per session):
//   - direct chats:  one derived AES key per conversation, invalidated when
//                    the partner's public key changes,
//   - group chats:   one unwrapped group key per (conversation, keyVersion);
//                    old versions stay cached so history remains readable.
//
// Plaintext cache: decrypted message texts and sent plaintexts, keyed by
// server id (or clientId while a message is still optimistic) so bubbles and
// sidebar previews never decrypt the same envelope twice. Cleared on logout.
// ============================================================================

import {
  DECRYPTION_FAILED_MESSAGE,
  DECRYPTION_FAILURE,
  decryptMessage,
  encryptMessage,
  warnDecryptionFailure,
} from './messageCrypto.js';
import { deriveSharedKey } from './sharedKey.js';
import { unwrapGroupKey } from './groupCrypto.js';

/** conversationId → { publicKey, key } for direct chats. */
const directKeyCache = new Map();
/** "conversationId:version" → AES key for group chats. */
const groupKeyCache = new Map();
/** "conversationId:messageId|clientId" → decrypted/known plaintext. */
const plaintextCache = new Map();

export const KEY_UNAVAILABLE_MESSAGE = 'Encryption key is not available for this conversation';

// ---------------------------------------------------------------------------
// Cache plumbing
// ---------------------------------------------------------------------------

function messageCacheKey(conversationId, message) {
  const id = message?.id ?? message?.clientId;
  return id ? `${conversationId}:${id}` : null;
}

/** Remembers a plaintext we already know (own sends, successful decrypts). */
export function rememberMessagePlaintext(conversationId, message, text) {
  if (typeof text !== 'string') return;
  const key = messageCacheKey(conversationId, message);
  if (key) plaintextCache.set(key, text);
}

/** The remembered plaintext for a message, or undefined. */
export function getRememberedMessagePlaintext(conversationId, message) {
  const key = messageCacheKey(conversationId, message);
  return key ? plaintextCache.get(key) : undefined;
}

/** Stores an already-unwrapped group key (used for keys we just created). */
export function rememberGroupKey(conversationId, version, key) {
  if (conversationId && version && key) {
    groupKeyCache.set(`${conversationId}:${version}`, key);
  }
}

/**
 * Drops every cached key/plaintext. Called on logout and whenever the session
 * changes so no key material survives another user on the same device.
 */
export function clearCryptoCaches(conversationId) {
  if (conversationId === undefined) {
    directKeyCache.clear();
    groupKeyCache.clear();
    plaintextCache.clear();
    return;
  }

  const prefix = `${conversationId}:`;
  for (const key of groupKeyCache.keys()) {
    if (key.startsWith(prefix)) groupKeyCache.delete(key);
  }
  for (const key of plaintextCache.keys()) {
    if (key.startsWith(prefix)) plaintextCache.delete(key);
  }
  directKeyCache.delete(conversationId);
}

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

/** The other member of a direct conversation (null for groups / missing data). */
function otherMember(conversation, currentUserId) {
  return (conversation?.members ?? []).find((member) => member.id !== currentUserId) ?? null;
}

/**
 * Derives (and caches) the direct-chat key between me and the other member.
 * Returns null when either side has no key material.
 */
export async function getDirectEncryptionKey(conversation, privateKey, currentUserId) {
  if (!privateKey || !conversation) return null;

  const other = otherMember(conversation, currentUserId);
  if (!other?.publicKey) return null;

  const cached = directKeyCache.get(conversation.id);
  if (cached && cached.publicKey === other.publicKey) return cached.key;

  try {
    const key = await deriveSharedKey(privateKey, other.publicKey);
    directKeyCache.set(conversation.id, { publicKey: other.publicKey, key });
    return key;
  } catch {
    return null;
  }
}

/**
 * Unwraps (and caches) the group key for one key version.
 * The envelope for me was wrapped by `wrappedBy`; their public key comes from
 * the conversation member list. Returns null when the envelope is missing
 * (joined after that version) or cannot be unwrapped.
 */
export async function getGroupEncryptionKey(conversation, privateKey, currentUserId, version) {
  if (!privateKey || !conversation) return null;

  const targetVersion = version ?? conversation.currentKeyVersion ?? 1;
  const cacheId = `${conversation.id}:${targetVersion}`;
  const cached = groupKeyCache.get(cacheId);
  if (cached) return cached;

  const envelope = (conversation.groupKeys ?? []).find(
    (entry) => entry.userId === currentUserId && entry.version === targetVersion
  );
  if (!envelope) return null;

  const wrapper = (conversation.members ?? []).find((member) => member.id === envelope.wrappedBy);
  if (!wrapper?.publicKey) return null;

  try {
    const key = await unwrapGroupKey(
      { wrappedKey: envelope.wrappedKey, iv: envelope.iv },
      privateKey,
      wrapper.publicKey
    );
    groupKeyCache.set(cacheId, key);
    return key;
  } catch {
    return null;
  }
}

/**
 * The AES-GCM key that protects messages of this conversation/version.
 * Direct conversations ignore the version (they have no rotations).
 */
export function getConversationEncryptionKey(conversation, privateKey, currentUserId, version) {
  if (!conversation) return Promise.resolve(null);
  if (conversation.type === 'group') {
    return getGroupEncryptionKey(conversation, privateKey, currentUserId, version);
  }
  return getDirectEncryptionKey(conversation, privateKey, currentUserId);
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt
// ---------------------------------------------------------------------------

/**
 * Encrypts outgoing text for a conversation.
 * Returns { ciphertext, iv, keyVersion }. Throws when no key is available —
 * callers must surface that as a failed send rather than sending plaintext.
 */
export async function encryptForConversation(conversation, privateKey, currentUserId, plaintext) {
  const keyVersion = conversation?.type === 'group' ? conversation.currentKeyVersion ?? 1 : 1;
  const key = await getConversationEncryptionKey(
    conversation,
    privateKey,
    currentUserId,
    keyVersion
  );

  if (!key) throw new Error(KEY_UNAVAILABLE_MESSAGE);

  const { ciphertext, iv } = await encryptMessage(key, plaintext);
  return { ciphertext, iv, keyVersion };
}

/**
 * Decrypts one stored message for display.
 *   - system messages and legacy plaintext are returned verbatim,
 *   - encrypted payloads are decrypted (or served from the plaintext cache),
 *   - any failure returns the standard placeholder instead of throwing.
 */
export async function decryptForConversation(conversation, privateKey, currentUserId, message) {
  if (!message) return DECRYPTION_FAILED_MESSAGE;
  if (message.deleted) return DECRYPTION_FAILED_MESSAGE;

  const cached = getRememberedMessagePlaintext(conversation.id, message);
  if (cached !== undefined) return cached;

  // Unencrypted rows: system activity lines ("Alex added Sam") and messages
  // from the pre-E2EE phases. No key involved.
  if (message.encrypted !== true) return message.ciphertext ?? '';

  if (!privateKey) {
    warnDecryptionFailure(DECRYPTION_FAILURE.KEY_MISSING);
    return DECRYPTION_FAILED_MESSAGE;
  }

  const key = await getConversationEncryptionKey(
    conversation,
    privateKey,
    currentUserId,
    message.keyVersion ?? 1
  );
  const text = await decryptMessage(key, { ciphertext: message.ciphertext, iv: message.iv });

  if (text !== DECRYPTION_FAILED_MESSAGE) {
    rememberMessagePlaintext(conversation.id, message, text);
  }
  return text;
}
