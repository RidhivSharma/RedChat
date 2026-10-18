// Browser-local notification + mute helpers.
//
// Privacy rules:
//   - a notification never contains message text or any decrypted content —
//     only the sender's display name and a neutral "New message" body,
//   - the permission prompt only appears after the user clicks
//     "Enable notifications" (never on page load),
//   - a muted conversation never produces notifications.

const MUTED_STORAGE_KEY = 'redchat.mutedConversations';

/** Custom event a notification click fires to open a conversation. */
export const OPEN_CONVERSATION_EVENT = 'redchat:open-conversation';

export function notificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** 'granted' | 'denied' | 'default' | 'unsupported'. */
export function notificationPermission() {
  if (!notificationsSupported()) return 'unsupported';
  return Notification.permission;
}

/** Must be called from a user gesture (the "Enable notifications" click). */
export async function requestNotificationPermission() {
  if (!notificationsSupported()) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

/**
 * Shows a desktop notification for an incoming message. No-op unless the
 * permission is granted AND the tab is hidden (the in-app UI covers the rest).
 * Clicking it focuses the window and asks the chat layer to open the
 * conversation.
 */
export function showMessageNotification({ senderName, conversationId }) {
  if (!notificationsSupported() || Notification.permission !== 'granted') return null;
  if (typeof document === 'undefined' || !document.hidden) return null;
  if (!conversationId) return null;

  try {
    const notification = new Notification(senderName || 'New message', {
      body: 'New message',
      tag: `redchat-conversation-${conversationId}`,
      // Re-using the tag replaces the previous notification of that
      // conversation instead of stacking one per message.
      renotify: false,
    });

    notification.onclick = () => {
      try {
        window.focus();
        window.dispatchEvent(
          new CustomEvent(OPEN_CONVERSATION_EVENT, { detail: { conversationId } })
        );
      } finally {
        notification.close();
      }
    };

    return notification;
  } catch {
    // Notification constructors can throw (e.g. non-secure context).
    return null;
  }
}

/** Subscribes to "open this conversation" requests (notification clicks). */
export function onOpenConversationRequest(handler) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(OPEN_CONVERSATION_EVENT, handler);
  return () => window.removeEventListener(OPEN_CONVERSATION_EVENT, handler);
}

// ---- Per-conversation mute (localStorage) ---------------------------------

function readMutedIds() {
  try {
    const raw = localStorage.getItem(MUTED_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeMutedIds(ids) {
  try {
    localStorage.setItem(MUTED_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Storage unavailable: muting simply does not persist.
  }
}

export function isConversationMuted(conversationId) {
  if (!conversationId) return false;
  return readMutedIds().includes(String(conversationId));
}

/** Every muted conversation id — lets the UI mirror the stored preference. */
export function mutedConversationIds() {
  return readMutedIds();
}

/** Mutes or unmutes one conversation; returns the new state. */
export function setConversationMuted(conversationId, muted) {
  if (!conversationId) return false;
  const id = String(conversationId);
  const ids = readMutedIds().filter((entry) => entry !== id);
  if (muted) ids.push(id);
  writeMutedIds(ids);
  return Boolean(muted);
}
