import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { conversationsApi } from '../services/api.js';
import {
  deleteMessage as emitDeleteMessage,
  sendMessage as emitSendMessage,
  sendMessageDelivered as emitMessageDelivered,
  sendMessageRead as emitMessageRead,
  startTyping as emitTypingStart,
  stopTyping as emitTypingStop,
} from '../services/socket.js';
import { createClientId } from '../utils/id.js';
import { fromServerMessage } from '../utils/messages.js';
import {
  isConversationMuted,
  onOpenConversationRequest,
  showMessageNotification,
} from '../utils/notifications.js';
import { hasReceipt } from '../utils/receipts.js';
import { setUnreadTitleCount } from '../utils/title.js';
import {
  KEY_UNAVAILABLE_MESSAGE,
  clearCryptoCaches,
  createGroupKey,
  encryptForConversation,
  getGroupEncryptionKey,
  rememberGroupKey,
  rememberMessagePlaintext,
  wrapGroupKeyForMember,
} from '../utils/crypto/index.js';
import { useAuth } from '../hooks/useAuth.js';
import { useSocket } from '../hooks/useSocket.js';
import { useToast } from '../hooks/useToast.js';

export const ChatContext = createContext(null);

/** Messages per history page (the server default is 30 too). */
export const MESSAGE_PAGE_SIZE = 30;

/**
 * A send that failed for a *transient* reason (offline, ack timeout) is
 * retried automatically with exponential backoff before the bubble turns
 * "failed". Permanent errors (validation, missing key, not a member) fail
 * immediately.
 */
const SEND_RETRY_DELAYS_MS = [1000, 2500, 5000];

/** Socket error codes that are worth retrying. */
const TRANSIENT_SEND_CODES = new Set(['OFFLINE', 'ACK_TIMEOUT', 'REQUEST_FAILED']);

/**
 * How long a received "is typing" flag survives without a fresh event. The
 * server only relays events (and does not broadcast a stop on disconnect), so
 * this is the receiver-side safety net.
 */
const TYPING_STALE_MS = 6000;

/** The sender's typing flag is switched off after this much inactivity. */
const TYPING_IDLE_MS = 3000;

/**
 * message:read is debounced: scrolling and bursts of incoming messages must
 * not fire one bulk read per keystroke/event. Only the final read point is
 * sent (everything up to the newest message).
 */
const KEY_REFRESH_MIN_INTERVAL_MS = 10_000;
const READ_DEBOUNCE_MS = 400;

/** message:delivered batches the messages that arrive in one burst. */
const DELIVERED_ACK_DEBOUNCE_MS = 300;

const EMPTY_HISTORY = Object.freeze({
  status: 'idle', // idle | loading | ready | error
  error: null,
  hasMore: false,
  nextBefore: null,
  loadingMore: false,
});

// ---------------------------------------------------------------------------
// Pure list helpers
// ---------------------------------------------------------------------------

function timestampOf(value) {
  const time = new Date(value ?? 0).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function sortConversations(list) {
  return [...list].sort((a, b) => {
    const byLastMessage = timestampOf(b.lastMessageAt) - timestampOf(a.lastMessageAt);
    if (byLastMessage !== 0) return byLastMessage;
    return timestampOf(b.createdAt) - timestampOf(a.createdAt);
  });
}

function upsertConversation(list, conversation) {
  const index = list.findIndex((item) => item.id === conversation.id);
  if (index === -1) return sortConversations([...list, conversation]);
  const next = [...list];
  next[index] = { ...next[index], ...conversation };
  return sortConversations(next);
}

function sortMessages(list) {
  return [...list].sort((a, b) => {
    const difference = timestampOf(a.createdAt) - timestampOf(b.createdAt);
    if (difference !== 0) return difference;
    return String(a.clientId ?? a.id).localeCompare(String(b.clientId ?? b.id));
  });
}

/**
 * Merges incoming server messages into a conversation timeline:
 *   - same server id        → update in place (read/delivery receipts later)
 *   - same clientId pending → the optimistic "sending" entry is confirmed
 *   - otherwise             → append
 */
function mergeMessages(current, incoming) {
  const next = [...current];

  for (const message of incoming) {
    const byId = message.id ? next.findIndex((item) => item.id === message.id) : -1;
    if (byId !== -1) {
      next[byId] = { ...next[byId], ...message, status: 'sent', error: null };
      continue;
    }

    const pending = message.clientId
      ? next.findIndex((item) => !item.id && item.clientId === message.clientId)
      : -1;
    if (pending !== -1) {
      next[pending] = { ...next[pending], ...message, status: 'sent', error: null };
      continue;
    }

    const known = message.clientId
      ? next.some((item) => item.clientId === message.clientId)
      : false;
    if (known) continue;

    next.push(message);
  }

  return sortMessages(next);
}

function updateMessageStatus(list, clientId, patch) {
  return list.map((message) =>
    !message.id && message.clientId === clientId ? { ...message, ...patch } : message
  );
}

/**
 * Page Visibility API: a hidden tab must never mark messages as read (the
 * user is not looking). Falls back to "visible" outside the browser.
 */
function readDocumentVisible() {
  if (typeof document === 'undefined') return true;
  return document.visibilityState !== 'hidden';
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Holds every chat fact the UI needs — conversations, messages per
 * conversation, presence, typing, the active conversation — and wires the
 * Socket.io events (message:new, message:deleted, conversation:new,
 * presence:update, presence:snapshot, typing). All HTTP calls stay in
 * services/api.js, all socket emits in services/socket.js.
 */
export function ChatProvider({ children }) {
  const { user, privateKey, keyStatus } = useAuth();
  const { socket, connectionCount } = useSocket();
  const { showToast } = useToast();

  const [conversations, setConversations] = useState([]);
  const [conversationsStatus, setConversationsStatus] = useState('loading');
  const [conversationsError, setConversationsError] = useState(null);

  const [messagesByConversation, setMessagesByConversation] = useState({});
  const [historyByConversation, setHistoryByConversation] = useState({});

  const [presence, setPresence] = useState({});
  const [typingByConversation, setTypingByConversation] = useState({});
  const [activeConversationId, setActiveConversationId] = useState(null);
  // "You are no longer a member of X" — set when a group removal arrives.
  const [removedNotice, setRemovedNotice] = useState(null);

  // Read receipts: the tab must be visible and the list scrolled to the
  // bottom before anything is marked as read (never from a hidden tab).
  const [documentVisible, setDocumentVisible] = useState(readDocumentVisible);
  const [atBottom, setAtBottom] = useState(true);

  // Refs mirroring the latest state, so socket handlers never go stale.
  const meIdRef = useRef(user?.id ?? null);
  const socketRef = useRef(socket);
  const activeIdRef = useRef(null);
  const conversationsRef = useRef(conversations);
  const messagesRef = useRef(messagesByConversation);
  const documentVisibleRef = useRef(documentVisible);
  // Encryption: the private key (non-extractable) and the E2EE status.
  const privateKeyRef = useRef(privateKey);
  const keyStatusRef = useRef(keyStatus);
  const authUserRef = useRef(user);
  const typingTimersRef = useRef(new Map()); // "conv:user" → stale-clear timeout
  const outgoingTypingRef = useRef(new Map()); // convId → { active, timer }
  const loadingOlderRef = useRef(new Set()); // conversations with a page in flight
  const connectedOnceRef = useRef(false);
  const pendingDeliveredRef = useRef(new Map()); // convId → { ids: Set, timer }
  const lastReadUpToRef = useRef(new Map()); // convId → message id already read
  const rotationInFlightRef = useRef(new Set()); // "convId:baseVersion" rotations
  const keyRefreshAtRef = useRef(new Map()); // convId → last key-material refetch (ms)
  const retryTimersRef = useRef(new Map()); // clientId → pending auto-retry timeout
  const deliverRef = useRef(null); // latest deliver(), for self-scheduling retries

  socketRef.current = socket;
  conversationsRef.current = conversations;
  messagesRef.current = messagesByConversation;
  documentVisibleRef.current = documentVisible;
  privateKeyRef.current = privateKey;
  keyStatusRef.current = keyStatus;
  authUserRef.current = user;

  // ---- conversations ------------------------------------------------------

  const seedPresenceFromMembers = useCallback((list) => {
    setPresence((current) => {
      let next = current;
      let changed = false;

      for (const conversation of list) {
        for (const member of conversation.members ?? []) {
          if (member.id === meIdRef.current) continue;

          const existing = next[member.id];
          if (!existing) {
            if (!changed) {
              next = { ...next };
              changed = true;
            }
            next[member.id] = { online: false, lastSeen: member.lastSeen ?? null };
            continue;
          }

          // Never let an older payload overwrite a fresher lastSeen.
          if (
            member.lastSeen &&
            (!existing.lastSeen || timestampOf(member.lastSeen) > timestampOf(existing.lastSeen))
          ) {
            if (!changed) {
              next = { ...next };
              changed = true;
            }
            next[member.id] = { ...existing, lastSeen: member.lastSeen };
          }
        }
      }

      return changed ? next : current;
    });
  }, []);

  const refreshConversations = useCallback(
    async ({ silent = false } = {}) => {
      if (!meIdRef.current) return;
      if (!silent) {
        setConversationsStatus('loading');
        setConversationsError(null);
      }

      try {
        const data = await conversationsApi.list();
        const list = data?.conversations ?? [];
        setConversations(sortConversations(list));
        setConversationsStatus('ready');
        setConversationsError(null);
        seedPresenceFromMembers(list);
      } catch (error) {
        if (silent) return; // keep the current list; the banner explains the outage
        setConversationsError(error);
        setConversationsStatus('error');
      }
    },
    [seedPresenceFromMembers]
  );

  /**
   * Refetches ONE conversation so its members' public keys and my group key
   * envelopes are current. A cached conversation can be stale: e.g. the other
   * person only published their key after this list was loaded (accounts that
   * predate encryption get keys at their next login). Without the key neither
   * side can derive the chat key and every message reads "Unable to decrypt".
   * Throttled per conversation so a persistently undecryptable message cannot
   * cause a request loop.
   */
  const refreshConversationKeys = useCallback(async (conversationId) => {
    if (!conversationId || !meIdRef.current) return;

    const now = Date.now();
    const last = keyRefreshAtRef.current.get(conversationId) ?? 0;
    if (now - last < KEY_REFRESH_MIN_INTERVAL_MS) return;
    keyRefreshAtRef.current.set(conversationId, now);

    try {
      const data = await conversationsApi.get(conversationId);
      if (!data?.conversation) return;
      // The unread badge is maintained locally; do not clobber it.
      const { unreadCount: _unreadCount, ...fresh } = data.conversation;
      setConversations((current) =>
        current.some((conversation) => conversation.id === conversationId)
          ? upsertConversation(current, fresh)
          : current
      );
    } catch {
      // Best effort: the placeholder simply stays until the next attempt.
    }
  }, []);

  // ---- history ------------------------------------------------------------

  const loadConversation = useCallback(async (conversationId, { silent = false } = {}) => {
    if (!conversationId) return;

    if (!silent) {
      setHistoryByConversation((current) => ({
        ...current,
        [conversationId]: { ...EMPTY_HISTORY, status: 'loading' },
      }));
    }

    try {
      const data = await conversationsApi.messages(conversationId, {
        limit: MESSAGE_PAGE_SIZE,
      });
      const incoming = (data?.messages ?? []).map(fromServerMessage);

      setMessagesByConversation((current) => ({
        ...current,
        [conversationId]: mergeMessages(current[conversationId] ?? [], incoming),
      }));
      setHistoryByConversation((current) => ({
        ...current,
        [conversationId]: {
          status: 'ready',
          error: null,
          hasMore: Boolean(data?.hasMore),
          nextBefore: data?.nextBefore ?? null,
          loadingMore: false,
        },
      }));
    } catch (error) {
      if (silent) return;
      setHistoryByConversation((current) => ({
        ...current,
        [conversationId]: { ...EMPTY_HISTORY, status: 'error', error },
      }));
    }
  }, []);

  const loadOlderMessages = useCallback(
    async (conversationId) => {
      const history = historyByConversation[conversationId];
      if (
        !conversationId ||
        !history ||
        history.status !== 'ready' ||
        !history.hasMore ||
        history.loadingMore ||
        !history.nextBefore ||
        loadingOlderRef.current.has(conversationId)
      ) {
        return;
      }

      loadingOlderRef.current.add(conversationId);
      setHistoryByConversation((current) => ({
        ...current,
        [conversationId]: { ...current[conversationId], loadingMore: true },
      }));

      try {
        const data = await conversationsApi.messages(conversationId, {
          before: history.nextBefore,
          limit: MESSAGE_PAGE_SIZE,
        });
        const incoming = (data?.messages ?? []).map(fromServerMessage);

        setMessagesByConversation((current) => ({
          ...current,
          [conversationId]: mergeMessages(current[conversationId] ?? [], incoming),
        }));
        setHistoryByConversation((current) => ({
          ...current,
          [conversationId]: {
            ...current[conversationId],
            loadingMore: false,
            hasMore: Boolean(data?.hasMore),
            nextBefore: data?.nextBefore ?? null,
          },
        }));
      } catch (error) {
        setHistoryByConversation((current) => ({
          ...current,
          [conversationId]: { ...current[conversationId], loadingMore: false },
        }));
        showToast(error?.message || 'Could not load older messages.', 'error');
      } finally {
        loadingOlderRef.current.delete(conversationId);
      }
    },
    [historyByConversation, showToast]
  );

  // ---- receipts (delivered / read) ---------------------------------------

  /**
   * Optimistic receipt write: `userId` delivered + read every message of the
   * conversation up to (and including) `upToMessage` that targets them.
   * Mirrors the server's bulk update so ticks/badges react before the
   * messages:read event echoes back.
   */
  const applyReceiptsUpTo = useCallback((conversationId, userId, upToMessage, receiptAt) => {
    const upToTime = timestampOf(upToMessage?.createdAt);
    if (!upToTime) return;

    const receipt = { user: userId, at: receiptAt ?? new Date().toISOString() };

    setMessagesByConversation((current) => {
      const list = current[conversationId];
      if (!list || list.length === 0) return current;

      let changed = false;
      const next = list.map((message) => {
        if (!message.id) return message;
        // Receipts never apply to the reader's own messages or to system lines.
        if (message.sender === userId || message.type === 'system') return message;
        if (timestampOf(message.createdAt) > upToTime) return message;

        const alreadyRead = hasReceipt(message.readBy, userId);
        const alreadyDelivered = hasReceipt(message.deliveredTo, userId);
        if (alreadyRead && alreadyDelivered) return message;

        changed = true;
        return {
          ...message,
          deliveredTo: alreadyDelivered
            ? message.deliveredTo
            : [...(message.deliveredTo ?? []), receipt],
          readBy: alreadyRead ? message.readBy : [...(message.readBy ?? []), receipt],
        };
      });

      return changed ? { ...current, [conversationId]: next } : current;
    });
  }, []);

  const clearUnreadBadge = useCallback((conversationId) => {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === conversationId && (conversation.unreadCount ?? 0) > 0
          ? { ...conversation, unreadCount: 0 }
          : conversation
      )
    );
  }, []);

  /** Sends the debounced batch of messages this client just received. */
  const flushDelivered = useCallback((conversationId) => {
    const entry = pendingDeliveredRef.current.get(conversationId);
    if (!entry) return;

    clearTimeout(entry.timer);
    pendingDeliveredRef.current.delete(conversationId);

    const messageIds = [...entry.ids];
    if (messageIds.length === 0) return;

    // Failures are fine: the server marks delivery for online members anyway
    // and catches up on the next connect.
    emitMessageDelivered(socketRef.current, { conversationId, messageIds }).catch(() => {});
  }, []);

  /** Batches the messages that arrive in one burst into one message:delivered. */
  const queueDelivered = useCallback(
    (conversationId, messageId) => {
      if (!conversationId || !messageId) return;

      let entry = pendingDeliveredRef.current.get(conversationId);
      if (!entry) {
        entry = { ids: new Set(), timer: null };
        pendingDeliveredRef.current.set(conversationId, entry);
      }
      entry.ids.add(messageId);
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => flushDelivered(conversationId), DELIVERED_ACK_DEBOUNCE_MS);
    },
    [flushDelivered]
  );

  /** MessageList reports its scroll position through this. */
  const notifyAtBottom = useCallback((value) => {
    setAtBottom((current) => (current === Boolean(value) ? current : Boolean(value)));
  }, []);

  /** Opens a conversation: clears its unread badge and (re)loads the latest page. */
  const selectConversation = useCallback(
    (conversationId) => {
      if (!conversationId) return;
      activeIdRef.current = conversationId;
      setActiveConversationId(conversationId);
      // The read receipt effect re-verifies this and emits message:read.
      setAtBottom(true);
      // Optimistic: the badge clears immediately, the read is written shortly.
      clearUnreadBadge(conversationId);
      loadConversation(conversationId);
    },
    [clearUnreadBadge, loadConversation]
  );

  /** Leaves the open conversation (mobile back): new messages count as unread again. */
  const closeConversation = useCallback(() => {
    activeIdRef.current = null;
    setActiveConversationId(null);
    setAtBottom(true);
  }, []);

  /** Removes a conversation from the list and closes it when it is open. */
  const dropConversation = useCallback((conversationId) => {
    if (activeIdRef.current === conversationId) {
      activeIdRef.current = null;
      setActiveConversationId(null);
      setAtBottom(true);
    }
    // A removed/left group's keys must not linger in memory.
    clearCryptoCaches(conversationId);
    setConversations((current) => current.filter((conversation) => conversation.id !== conversationId));
  }, []);

  const dismissRemovedNotice = useCallback(() => setRemovedNotice(null), []);

  // ---- typing (outgoing) --------------------------------------------------

  const stopTyping = useCallback((conversationId) => {
    const entry = outgoingTypingRef.current.get(conversationId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = null;
    if (entry.active) {
      entry.active = false;
      emitTypingStop(socketRef.current, conversationId).catch(() => {});
    }
  }, []);

  /** Called on every keystroke: starts typing once, stops after 3 s idle. */
  const notifyTyping = useCallback(
    (conversationId) => {
      if (!conversationId) return;
      let entry = outgoingTypingRef.current.get(conversationId);
      if (!entry) {
        entry = { active: false, timer: null };
        outgoingTypingRef.current.set(conversationId, entry);
      }

      if (!entry.active) {
        entry.active = true;
        emitTypingStart(socketRef.current, conversationId).catch(() => {});
      }

      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => stopTyping(conversationId), TYPING_IDLE_MS);
    },
    [stopTyping]
  );

  // ---- sending ------------------------------------------------------------

  /**
   * Encrypts and emits one message. There is no plain-text fallback: when the
   * conversation key is unavailable the bubble turns "failed" (the composer is
   * also gated on the key being ready, so this is the network/race path).
   *
   * Transient failures (offline, ack timeout) are retried automatically with
   * exponential backoff while the bubble stays in the "sending" state; only
   * after the last attempt (or on a permanent error) does it turn "failed".
   */
  const deliver = useCallback(
    async (conversationId, clientId, text, attempt = 0) => {
      try {
        const conversation = conversationsRef.current.find((item) => item.id === conversationId);
        if (!conversation) {
          throw new Error('This conversation is not available anymore.');
        }

        const payload = await encryptForConversation(
          conversation,
          privateKeyRef.current,
          meIdRef.current,
          text
        );

        const data = await emitSendMessage(socketRef.current, {
          conversationId,
          clientId,
          ciphertext: payload.ciphertext,
          iv: payload.iv,
          keyVersion: payload.keyVersion,
          encrypted: true,
        });

        if (data?.message) {
          const confirmed = fromServerMessage(data.message);
          // Remember our own plaintext under the server id as well, so the
          // confirmed bubble renders from cache without decrypting.
          rememberMessagePlaintext(conversationId, confirmed, text);
          setMessagesByConversation((current) => ({
            ...current,
            [conversationId]: mergeMessages(current[conversationId] ?? [], [confirmed]),
          }));
        } else {
          setMessagesByConversation((current) => ({
            ...current,
            [conversationId]: updateMessageStatus(current[conversationId] ?? [], clientId, {
              status: 'sent',
              error: null,
            }),
          }));
        }
        return true;
      } catch (error) {
        const transient = TRANSIENT_SEND_CODES.has(error?.code);
        if (transient && attempt < SEND_RETRY_DELAYS_MS.length) {
          // Stay "sending" and try again after the backoff — no error UI yet.
          setMessagesByConversation((current) => ({
            ...current,
            [conversationId]: updateMessageStatus(current[conversationId] ?? [], clientId, {
              status: 'sending',
              error: null,
            }),
          }));

          const previous = retryTimersRef.current.get(clientId);
          if (previous) clearTimeout(previous);
          const timer = setTimeout(() => {
            retryTimersRef.current.delete(clientId);
            deliverRef.current?.(conversationId, clientId, text, attempt + 1);
          }, SEND_RETRY_DELAYS_MS[attempt]);
          retryTimersRef.current.set(clientId, timer);
          return false;
        }

        setMessagesByConversation((current) => ({
          ...current,
          [conversationId]: updateMessageStatus(current[conversationId] ?? [], clientId, {
            status: 'failed',
            error: error?.message || KEY_UNAVAILABLE_MESSAGE,
          }),
        }));
        // No key usually means stale member data: refetch so "Retry" can work.
        if (error?.message === KEY_UNAVAILABLE_MESSAGE) {
          refreshConversationKeys(conversationId);
        }
        return false;
      }
    },
    [refreshConversationKeys]
  );

  deliverRef.current = deliver;

  /** Optimistic send: bubble appears instantly, then ack → sent / failed. */
  const sendMessage = useCallback(
    (conversationId, rawText) => {
      const text = String(rawText ?? '').trim();
      if (!conversationId || !text) return null;

      // Never send when the key is not in memory (the composer is disabled in
      // that state too — this is the defensive second gate).
      if (keyStatusRef.current !== 'ready' || !privateKeyRef.current) {
        showToast(KEY_UNAVAILABLE_MESSAGE, 'error');
        return null;
      }

      const clientId = createClientId();
      // Own plaintext is known: cache it so the bubble/preview render instantly.
      rememberMessagePlaintext(conversationId, { clientId }, text);
      const optimistic = {
        id: null,
        clientId,
        conversationId,
        sender: meIdRef.current,
        deleted: false,
        encrypted: true,
        text,
        createdAt: new Date().toISOString(),
        status: 'sending',
        error: null,
      };

      setMessagesByConversation((current) => ({
        ...current,
        [conversationId]: mergeMessages(current[conversationId] ?? [], [optimistic]),
      }));
      stopTyping(conversationId);
      deliver(conversationId, clientId, text);
      return clientId;
    },
    [deliver, showToast, stopTyping]
  );

  /** Retries a failed message with its original clientId (server dedupes). */
  const retryMessage = useCallback(
    (conversationId, clientId) => {
      const pending = (messagesRef.current[conversationId] ?? []).find(
        (message) => !message.id && message.clientId === clientId
      );
      if (!pending) return Promise.resolve(false);

      setMessagesByConversation((current) => ({
        ...current,
        [conversationId]: updateMessageStatus(current[conversationId] ?? [], clientId, {
          status: 'sending',
          error: null,
        }),
      }));
      return deliver(conversationId, clientId, pending.text);
    },
    [deliver]
  );

  /** "Delete for everyone" — throws so the caller can surface a toast. */
  const deleteMessage = useCallback(async (conversationId, messageId) => {
    await emitDeleteMessage(socketRef.current, messageId);
    setMessagesByConversation((current) => ({
      ...current,
      [conversationId]: (current[conversationId] ?? []).map((message) =>
        message.id === messageId ? { ...message, deleted: true, text: null } : message
      ),
    }));
  }, []);

  /** Finds or creates the direct conversation, then opens it. */
  const startDirectConversation = useCallback(
    async (userId) => {
      const data = await conversationsApi.startDirect(userId);
      const conversation = data?.conversation;
      if (!conversation) throw new Error('The conversation could not be created.');

      setConversations((current) => upsertConversation(current, conversation));
      selectConversation(conversation.id);
      return conversation;
    },
    [selectConversation]
  );

  /**
   * Creates a group: a fresh AES-GCM group key (version 1) is wrapped for
   * every member — including the creator — with each member's ECDH public key,
   * so the server only ever stores envelopes. Requires the local private key
   * and a public key for every selected member (no plain-text fallback).
   */
  const startGroupConversation = useCallback(
    async (name, memberUsers) => {
      const privateKey = privateKeyRef.current;
      const me = meIdRef.current;
      const myPublicKey = authUserRef.current?.publicKey;

      if (!privateKey || keyStatusRef.current !== 'ready') {
        throw new Error(KEY_UNAVAILABLE_MESSAGE);
      }

      const members = [...(memberUsers ?? [])];
      const missingKey = members.find((member) => !member?.publicKey);
      if (missingKey) {
        throw new Error(
          `${missingKey.displayName || missingKey.username || 'That person'} has not set up encryption yet and cannot join an encrypted group.`
        );
      }
      if (!myPublicKey) {
        throw new Error('Your own encryption key is not available — refresh and unlock again.');
      }

      const groupKey = await createGroupKey();
      const targets = [
        ...members.map((member) => ({ id: member.id, publicKey: member.publicKey })),
        { id: me, publicKey: myPublicKey },
      ];

      const groupKeys = [];
      for (const target of targets) {
        const wrapped = await wrapGroupKeyForMember(groupKey, privateKey, target.publicKey);
        groupKeys.push({
          userId: target.id,
          version: 1,
          wrappedKey: wrapped.wrappedKey,
          iv: wrapped.iv,
          wrappedBy: me,
        });
      }

      const data = await conversationsApi.createGroup({
        name,
        memberIds: members.map((member) => member.id),
        groupKeys,
      });
      const conversation = data?.conversation;
      if (!conversation) throw new Error('The group could not be created.');

      // We just made this key — remember it so the first send is instant.
      rememberGroupKey(conversation.id, conversation.currentKeyVersion ?? 1, groupKey);

      setConversations((current) => upsertConversation(current, conversation));
      seedPresenceFromMembers([conversation]);
      selectConversation(conversation.id);
      return conversation;
    },
    [seedPresenceFromMembers, selectConversation]
  );

  /** Shared bookkeeping for the admin group mutations. */
  const applyGroupChange = useCallback(
    (conversation) => {
      if (!conversation?.id) return null;
      setConversations((current) => upsertConversation(current, conversation));
      seedPresenceFromMembers([conversation]);
      return conversation;
    },
    [seedPresenceFromMembers]
  );

  /**
   * Adds members to a group (admins only server-side). Every group key version
   * the admin holds is unwrapped and re-wrapped for each newcomer, so they can
   * read everything sent from their join point onward while the server still
   * never sees a key.
   */
  const addGroupMembers = useCallback(
    async (conversationId, memberUsers) => {
      const privateKey = privateKeyRef.current;
      const me = meIdRef.current;

      if (!privateKey || keyStatusRef.current !== 'ready') {
        throw new Error(KEY_UNAVAILABLE_MESSAGE);
      }

      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      if (!conversation) throw new Error('This conversation is not available anymore.');

      const members = [...(memberUsers ?? [])];
      const missingKey = members.find((member) => !member?.publicKey);
      if (missingKey) {
        throw new Error(
          `${missingKey.displayName || missingKey.username || 'That person'} has not set up encryption yet and cannot join an encrypted group.`
        );
      }

      // Versions I actually hold (each account only receives its own envelopes,
      // so conversation.groupKeys is my personal set).
      const versions = [
        ...new Set((conversation.groupKeys ?? []).map((key) => key.version)),
      ].sort((a, b) => a - b);

      const groupKeys = [];
      for (const version of versions) {
        const groupKey = await getGroupEncryptionKey(conversation, privateKey, me, version);
        if (!groupKey) continue; // cannot hand over a key I cannot unwrap
        for (const member of members) {
          const wrapped = await wrapGroupKeyForMember(groupKey, privateKey, member.publicKey);
          groupKeys.push({
            userId: member.id,
            version,
            wrappedKey: wrapped.wrappedKey,
            iv: wrapped.iv,
            wrappedBy: me,
          });
        }
      }

      const data = await conversationsApi.addMembers(
        conversationId,
        members.map((member) => member.id),
        groupKeys
      );
      return applyGroupChange(data?.conversation);
    },
    [applyGroupChange]
  );

  /** Removes another member from a group (admins only server-side). */
  const removeGroupMember = useCallback(
    async (conversationId, userId) => {
      const data = await conversationsApi.removeMember(conversationId, userId);
      return applyGroupChange(data?.conversation);
    },
    [applyGroupChange]
  );

  /** Renames a group (admins only server-side). */
  const renameGroup = useCallback(
    async (conversationId, name) => {
      const data = await conversationsApi.rename(conversationId, name);
      return applyGroupChange(data?.conversation);
    },
    [applyGroupChange]
  );

  /** Promotes a member to group admin (admins only server-side). */
  const promoteGroupAdmin = useCallback(
    async (conversationId, userId) => {
      const data = await conversationsApi.promoteAdmin(conversationId, userId);
      return applyGroupChange(data?.conversation);
    },
    [applyGroupChange]
  );

  /**
   * Leaves a group (self-removal). The server also emits
   * "conversation:removed" (with `left: true`); dropping locally covers a
   * momentarily disconnected socket.
   */
  const leaveGroup = useCallback(
    async (conversationId) => {
      await conversationsApi.removeMember(conversationId, meIdRef.current);
      dropConversation(conversationId);
    },
    [dropConversation]
  );

  // ---- group key rotation ------------------------------------------------

  /**
   * Rotates the group key after a member was removed/left: generate a brand-new
   * key at `baseVersion + 1`, wrap it for every CURRENT member (myself
   * included) and POST it. Only admins receive the rotation request; when two
   * admins race, the loser gets 409 STALE_KEY_VERSION and simply keeps the key
   * that arrives through "conversation:keys".
   */
  const rotateGroupKey = useCallback(
    async (conversationId, baseVersion) => {
      const rotationKey = `${conversationId}:${baseVersion}`;
      if (rotationInFlightRef.current.has(rotationKey)) return;
      rotationInFlightRef.current.add(rotationKey);

      try {
        const privateKey = privateKeyRef.current;
        const me = meIdRef.current;
        const myPublicKey = authUserRef.current?.publicKey;
        const conversation = conversationsRef.current.find((item) => item.id === conversationId);

        // Another admin without keys may still rotate; we just skip silently.
        if (!privateKey || !myPublicKey || !conversation) return;

        const members = [...(conversation.members ?? [])];
        if (members.some((member) => member.id !== me && !member.publicKey)) return;

        const newVersion = baseVersion + 1;
        const groupKey = await createGroupKey();
        const groupKeys = [];
        for (const member of members) {
          const publicKey = member.id === me ? myPublicKey : member.publicKey;
          const wrapped = await wrapGroupKeyForMember(groupKey, privateKey, publicKey);
          groupKeys.push({
            userId: member.id,
            version: newVersion,
            wrappedKey: wrapped.wrappedKey,
            iv: wrapped.iv,
            wrappedBy: me,
          });
        }

        const data = await conversationsApi.rotateKeys(conversationId, baseVersion, groupKeys);
        rememberGroupKey(conversationId, newVersion, groupKey);
        applyGroupChange(data?.conversation);
      } catch (error) {
        if (error?.code !== 'STALE_KEY_VERSION') {
          showToast(error?.message || 'Could not rotate the group key.', 'error');
        }
      } finally {
        rotationInFlightRef.current.delete(rotationKey);
      }
    },
    [applyGroupChange, showToast]
  );

  const handleRotateKeyRequested = useCallback(
    ({ conversationId, baseVersion } = {}) => {
      if (!conversationId || !Number.isInteger(baseVersion)) return;
      rotateGroupKey(conversationId, baseVersion);
    },
    [rotateGroupKey]
  );

  /**
   * "conversation:keys" — my personal fresh envelope(s) after somebody else
   * rotated the group key. Merge them in and adopt the new version; the key
   * itself is unwrapped lazily (and cached) the first time it is needed.
   */
  const handleConversationKeys = useCallback(
    ({ conversationId, currentKeyVersion, groupKeys } = {}) => {
      if (!conversationId) return;
      const incoming = Array.isArray(groupKeys) ? groupKeys : [];

      setConversations((current) =>
        current.map((conversation) => {
          if (conversation.id !== conversationId) return conversation;

          const keep = (conversation.groupKeys ?? []).filter(
            (key) =>
              !incoming.some(
                (entry) => entry.userId === key.userId && entry.version === key.version
              )
          );

          return {
            ...conversation,
            currentKeyVersion: currentKeyVersion ?? conversation.currentKeyVersion,
            groupKeys: [...keep, ...incoming],
          };
        })
      );
    },
    []
  );

  // ---- incoming socket events --------------------------------------------

  const handleMessageNew = useCallback(
    ({ message } = {}) => {
      if (!message?.id || !message?.conversationId) return;
      const conversationId = message.conversationId;
      const normalized = fromServerMessage(message);

      setMessagesByConversation((current) => ({
        ...current,
        [conversationId]: mergeMessages(current[conversationId] ?? [], [normalized]),
      }));

      const knownConversation = conversationsRef.current.find(
        (conversation) => conversation.id === conversationId
      );
      if (!knownConversation) {
        // A conversation we have never listed (e.g. just created elsewhere).
        refreshConversations({ silent: true });
        return;
      }

      const isMine = message.sender === meIdRef.current;
      const isSystem = normalized.type === 'system';
      const isActive = activeIdRef.current === conversationId;

      // An encrypted message from someone whose public key we do not have (or
      // from a conversation whose key envelope for the sent version is missing)
      // cannot be decrypted with stale data — refetch the conversation now.
      if (normalized.encrypted && !isSystem && !isMine) {
        const senderMember = (knownConversation.members ?? []).find(
          (member) => member.id === message.sender
        );
        if (!senderMember?.publicKey) refreshConversationKeys(conversationId);
      }
      // A hidden tab (or a conversation that is not open) never counts as
      // "seen": the unread badge must keep growing until the user looks.
      const visible = documentVisibleRef.current;

      // Desktop notification for a message the user cannot see: hidden tab,
      // not the open conversation, not muted. Content is never included — the
      // title is the sender's display name, the body is "New message".
      if (
        !isMine &&
        !isSystem &&
        !visible &&
        !isActive &&
        !isConversationMuted(conversationId)
      ) {
        const senderMember = (knownConversation.members ?? []).find(
          (member) => member.id === message.sender
        );
        showMessageNotification({
          senderName: senderMember?.displayName || senderMember?.username || 'New message',
          conversationId,
        });
      }

      if (!isMine && !isSystem) {
        // Confirm receipt in one debounced batch: ticks turn "delivered".
        queueDelivered(conversationId, normalized.id);
      }

      setConversations((current) =>
        sortConversations(
          current.map((conversation) => {
            if (conversation.id !== conversationId) return conversation;
            return {
              ...conversation,
              lastMessageAt: normalized.createdAt ?? conversation.lastMessageAt,
              lastMessageId: normalized.id,
              // Activity lines bump the group to the top but are not unread.
              unreadCount:
                !isMine && !isSystem && (!isActive || !visible)
                  ? (conversation.unreadCount ?? 0) + 1
                  : conversation.unreadCount,
            };
          })
        )
      );
    },
    [queueDelivered, refreshConversations, refreshConversationKeys]
  );

  /** message:status — per-message deliveredTo/readBy replacement. */
  const handleMessageStatus = useCallback((payload = {}) => {
    const { conversationId, messageId, deliveredTo, readBy } = payload;
    if (!conversationId || !messageId) return;

    setMessagesByConversation((current) => {
      const list = current[conversationId];
      if (!list || list.length === 0) return current;

      const index = list.findIndex((message) => message.id === messageId);
      if (index === -1) return current;

      const next = [...list];
      next[index] = {
        ...next[index],
        deliveredTo: deliveredTo ?? [],
        readBy: readBy ?? [],
      };
      return { ...current, [conversationId]: next };
    });
  }, []);

  /** messages:read — one batch read (own device or someone reading mine). */
  const handleMessagesRead = useCallback(
    (payload = {}) => {
      const { conversationId, userId, upToMessageId, upToMessageAt, at } = payload;
      if (!conversationId || !userId) return;

      const me = meIdRef.current;
      // Prefer the server timestamp; fall back to the local read point.
      let upToMessage = upToMessageAt ? { createdAt: upToMessageAt } : null;
      if (!upToMessage && upToMessageId) {
        const local = (messagesRef.current[conversationId] ?? []).find(
          (message) => message.id === upToMessageId
        );
        if (local) upToMessage = local;
      }
      if (!upToMessage) return;

      applyReceiptsUpTo(conversationId, userId, upToMessage, at);
      if (userId === me) clearUnreadBadge(conversationId);
    },
    [applyReceiptsUpTo, clearUnreadBadge]
  );

  const handleMessageDeleted = useCallback(({ conversationId, messageId } = {}) => {
    if (!conversationId || !messageId) return;
    setMessagesByConversation((current) => ({
      ...current,
      [conversationId]: (current[conversationId] ?? []).map((message) =>
        message.id === messageId ? { ...message, deleted: true, text: null } : message
      ),
    }));
  }, []);

  const handleConversationNew = useCallback(
    ({ conversation } = {}) => {
      if (!conversation?.id) return;
      setConversations((current) => upsertConversation(current, conversation));
      seedPresenceFromMembers([conversation]);
    },
    [seedPresenceFromMembers]
  );

  /** conversation:updated — members/name/admins changed (no unreadCount key). */
  const handleConversationUpdated = useCallback(
    ({ conversation } = {}) => {
      if (!conversation?.id) return;
      setConversations((current) => upsertConversation(current, conversation));
      seedPresenceFromMembers([conversation]);
    },
    [seedPresenceFromMembers]
  );

  /**
   * conversation:removed — this user was removed from (or left) a group:
   * drop it from the list, close it when it is open, and show a "no longer a
   * member" notice unless the user left voluntarily (`left: true`).
   */
  const handleConversationRemoved = useCallback(
    ({ conversationId, left } = {}) => {
      if (!conversationId) return;
      const known = conversationsRef.current.find(
        (conversation) => conversation.id === conversationId
      );
      dropConversation(conversationId);
      if (!left) {
        setRemovedNotice({ conversationId, name: known?.name ?? null });
      }
    },
    [dropConversation]
  );

  const handlePresenceUpdate = useCallback((payload = {}) => {
    const { userId, online, lastSeen } = payload;
    if (!userId) return;
    setPresence((current) => {
      const existing = current[userId];
      return {
        ...current,
        [userId]: {
          online: Boolean(online),
          lastSeen: lastSeen ?? existing?.lastSeen ?? null,
        },
      };
    });
  }, []);

  const handlePresenceSnapshot = useCallback(({ users } = {}) => {
    if (!Array.isArray(users) || users.length === 0) return;
    setPresence((current) => {
      const next = { ...current };
      for (const entry of users) {
        if (!entry?.userId) continue;
        next[entry.userId] = {
          online: Boolean(entry.online),
          lastSeen: next[entry.userId]?.lastSeen ?? null,
        };
      }
      return next;
    });
  }, []);

  const handleTyping = useCallback((payload = {}) => {
    const { conversationId, userId, isTyping } = payload;
    if (!conversationId || !userId) return;

    const key = `${conversationId}:${userId}`;
    const timers = typingTimersRef.current;
    clearTimeout(timers.get(key));
    timers.delete(key);

    setTypingByConversation((current) => {
      const forConversation = { ...(current[conversationId] ?? {}) };
      if (isTyping) forConversation[userId] = true;
      else delete forConversation[userId];
      return { ...current, [conversationId]: forConversation };
    });

    if (isTyping) {
      // Safety net: clear the flag if no stop event ever arrives.
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          setTypingByConversation((current) => {
            const forConversation = { ...(current[conversationId] ?? {}) };
            delete forConversation[userId];
            return { ...current, [conversationId]: forConversation };
          });
        }, TYPING_STALE_MS)
      );
    }
  }, []);

  // ---- lifecycle ----------------------------------------------------------

  // Session switch: load conversations for the user, wipe state on logout.
  useEffect(() => {
    meIdRef.current = user?.id ?? null;
    connectedOnceRef.current = false;

    // A session switch starts with a clean receipt slate.
    for (const entry of pendingDeliveredRef.current.values()) clearTimeout(entry.timer);
    pendingDeliveredRef.current.clear();
    for (const timer of retryTimersRef.current.values()) clearTimeout(timer);
    retryTimersRef.current.clear();
    lastReadUpToRef.current.clear();
    setRemovedNotice(null);

    if (!user) {
      activeIdRef.current = null;
      setConversations([]);
      setConversationsStatus('loading');
      setConversationsError(null);
      setMessagesByConversation({});
      setHistoryByConversation({});
      setPresence({});
      setTypingByConversation({});
      setActiveConversationId(null);
      setAtBottom(true);
      return;
    }

    refreshConversations();
  }, [user, refreshConversations]);

  // Socket event wiring (re-registered whenever the socket instance changes).
  useEffect(() => {
    if (!socket) return undefined;

    socket.on('message:new', handleMessageNew);
    socket.on('message:deleted', handleMessageDeleted);
    socket.on('message:status', handleMessageStatus);
    socket.on('messages:read', handleMessagesRead);
    socket.on('conversation:new', handleConversationNew);
    socket.on('conversation:updated', handleConversationUpdated);
    socket.on('conversation:removed', handleConversationRemoved);
    socket.on('conversation:keys', handleConversationKeys);
    socket.on('conversation:rotate-key', handleRotateKeyRequested);
    socket.on('presence:update', handlePresenceUpdate);
    socket.on('presence:snapshot', handlePresenceSnapshot);
    socket.on('typing', handleTyping);

    return () => {
      socket.off('message:new', handleMessageNew);
      socket.off('message:deleted', handleMessageDeleted);
      socket.off('message:status', handleMessageStatus);
      socket.off('messages:read', handleMessagesRead);
      socket.off('conversation:new', handleConversationNew);
      socket.off('conversation:updated', handleConversationUpdated);
      socket.off('conversation:removed', handleConversationRemoved);
      socket.off('conversation:keys', handleConversationKeys);
      socket.off('conversation:rotate-key', handleRotateKeyRequested);
      socket.off('presence:update', handlePresenceUpdate);
      socket.off('presence:snapshot', handlePresenceSnapshot);
      socket.off('typing', handleTyping);
    };
  }, [
    socket,
    handleMessageNew,
    handleMessageDeleted,
    handleMessageStatus,
    handleMessagesRead,
    handleConversationNew,
    handleConversationUpdated,
    handleConversationRemoved,
    handleConversationKeys,
    handleRotateKeyRequested,
    handlePresenceUpdate,
    handlePresenceSnapshot,
    handleTyping,
  ]);

  // Page Visibility API: hidden tabs never mark anything as read.
  useEffect(() => {
    function handleVisibilityChange() {
      setDocumentVisible(readDocumentVisible());
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // Read receipts: while the open conversation is visible and scrolled to the
  // bottom, everything from others is marked read — debounced, and also when a
  // new message lands in that conversation. `connectionCount` retries reads
  // that failed while the socket was down.
  const activeMessages = useMemo(
    () => (activeConversationId ? messagesByConversation[activeConversationId] ?? [] : []),
    [messagesByConversation, activeConversationId]
  );

  useEffect(() => {
    if (!activeConversationId || !documentVisible || !atBottom) return undefined;

    const me = meIdRef.current;
    // The read point is the newest message the server knows about; a still
    // sending/failed optimistic bubble at the bottom must not block it.
    let last = null;
    for (let index = activeMessages.length - 1; index >= 0; index -= 1) {
      if (activeMessages[index].id) {
        last = activeMessages[index];
        break;
      }
    }
    if (!last) return undefined;

    const hasUnread = activeMessages.some(
      (message) =>
        message.id &&
        message.type !== 'system' &&
        message.sender !== me &&
        !hasReceipt(message.readBy, me)
    );
    if (!hasUnread) return undefined;
    if (lastReadUpToRef.current.get(activeConversationId) === last.id) return undefined;

    const conversationId = activeConversationId;
    const timer = setTimeout(async () => {
      try {
        const data = await emitMessageRead(socketRef.current, {
          conversationId,
          upToMessageId: last.id,
        });
        lastReadUpToRef.current.set(conversationId, last.id);
        applyReceiptsUpTo(conversationId, me, last, data?.at);
        clearUnreadBadge(conversationId);
      } catch {
        // Offline / timeout: the next message, scroll or reconnect retries.
      }
    }, READ_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [
    activeConversationId,
    activeMessages,
    documentVisible,
    atBottom,
    connectionCount,
    applyReceiptsUpTo,
    clearUnreadBadge,
  ]);

  // Browser tab title prefix: "(3) …" while there is anything unread. The
  // base part belongs to the page (usePageTitle) — utils/title.js joins them.
  const totalUnread = useMemo(
    () =>
      conversations.reduce(
        (sum, conversation) => sum + Math.max(0, conversation.unreadCount ?? 0),
        0
      ),
    [conversations]
  );

  useEffect(() => {
    setUnreadTitleCount(totalUnread);
  }, [totalUnread]);

  // The unread prefix is chat-session state: never leak it into the login page.
  useEffect(() => () => setUnreadTitleCount(0), []);

  // Notification clicks (browser Notification) ask to open a conversation.
  // Unknown conversations are refetched first so the chat layer has them.
  useEffect(
    () =>
      onOpenConversationRequest((event) => {
        const conversationId = event?.detail?.conversationId;
        if (!conversationId) return;
        if (conversationsRef.current.some((conversation) => conversation.id === conversationId)) {
          selectConversation(conversationId);
          return;
        }
        refreshConversations({ silent: true }).then(() => selectConversation(conversationId));
      }),
    [refreshConversations, selectConversation]
  );

  // Reconnect: refetch conversations and the open conversation's latest page so
  // nothing sent while offline is missed. The first connect is skipped — the
  // initial load already covers it.
  useEffect(() => {
    if (connectionCount === 0) return;
    if (!connectedOnceRef.current) {
      connectedOnceRef.current = true;
      return;
    }

    refreshConversations({ silent: true });
    const activeId = activeIdRef.current;
    if (activeId) loadConversation(activeId, { silent: true });
  }, [connectionCount, refreshConversations, loadConversation]);

  // Stop every outgoing typing flag and flush/cancel pending receipt batches
  // and send-retry timers when the chat layer goes away.
  useEffect(() => {
    const outgoing = outgoingTypingRef.current;
    const timers = typingTimersRef.current;
    const pendingDelivered = pendingDeliveredRef.current;
    const retryTimers = retryTimersRef.current;
    return () => {
      for (const entry of outgoing.values()) clearTimeout(entry.timer);
      outgoing.clear();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const entry of pendingDelivered.values()) clearTimeout(entry.timer);
      pendingDelivered.clear();
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
    };
  }, []);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId) ?? null,
    [conversations, activeConversationId]
  );

  const value = useMemo(
    () => ({
      conversations,
      conversationsStatus,
      conversationsError,
      messagesByConversation,
      historyByConversation,
      presence,
      typingByConversation,
      activeConversationId,
      activeConversation,
      removedNotice,
      // Encryption state for the UI gating (composer disabled when not ready).
      keyStatus,
      encryptionReady: keyStatus === 'ready',
      refreshConversations,
      refreshConversationKeys,
      selectConversation,
      closeConversation,
      dismissRemovedNotice,
      reloadConversation: loadConversation,
      loadOlderMessages,
      sendMessage,
      retryMessage,
      deleteMessage,
      notifyTyping,
      stopTyping,
      notifyAtBottom,
      startDirectConversation,
      startGroupConversation,
      addGroupMembers,
      removeGroupMember,
      renameGroup,
      promoteGroupAdmin,
      leaveGroup,
    }),
    [
      conversations,
      conversationsStatus,
      conversationsError,
      messagesByConversation,
      historyByConversation,
      presence,
      typingByConversation,
      activeConversationId,
      activeConversation,
      removedNotice,
      keyStatus,
      refreshConversations,
      refreshConversationKeys,
      selectConversation,
      closeConversation,
      dismissRemovedNotice,
      loadConversation,
      loadOlderMessages,
      sendMessage,
      retryMessage,
      deleteMessage,
      notifyTyping,
      stopTyping,
      notifyAtBottom,
      startDirectConversation,
      startGroupConversation,
      addGroupMembers,
      removeGroupMember,
      renameGroup,
      promoteGroupAdmin,
      leaveGroup,
    ]
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export default ChatProvider;
