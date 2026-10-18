import { serializeConversation, serializeMessage } from '../utils/serialize.js';
import { getIO } from './index.js';
import { isOnline } from './presence.js';
import { conversationRoom, personalRoom } from './rooms.js';

/**
 * Announces a freshly created conversation to its members (called by the
 * REST controllers today; socket-side creation reuses the same function):
 *   - every member's sockets join the "conv:<id>" room,
 *   - every member receives "conversation:new" with their own view of the
 *     conversation (own group key envelopes).
 * No-op when the realtime layer is not attached (e.g. REST-only test runs).
 */
export function announceConversationCreated(conversation) {
  const io = getIO();
  if (!io || !conversation) return;

  const room = conversationRoom(conversation._id);

  for (const member of conversation.members ?? []) {
    const memberId = (member._id ?? member).toString();

    // Join first, then notify, so messages sent right after are delivered.
    io.in(personalRoom(memberId)).socketsJoin(room);
    io.to(personalRoom(memberId)).emit('conversation:new', {
      conversation: serializeConversation(conversation, {
        unreadCount: 0,
        groupKeysFor: memberId,
      }),
    });
  }
}

/**
 * "conversation:updated" { conversation } to the whole conversation room —
 * every membership/name/admin change uses this. Serialized WITHOUT
 * unreadCount so recipients' badges are never reset by a broadcast, and
 * without groupKeys (per-member key envelopes only go to the specific member
 * through "conversation:new").
 */
export function announceConversationUpdated(conversation) {
  const io = getIO();
  if (!io || !conversation) return;

  io.to(conversationRoom(conversation._id)).emit('conversation:updated', {
    conversation: serializeConversation(conversation),
  });
}

/**
 * Adds a newly added member's sockets to the conversation room and sends them
 * "conversation:new" (their personal view, own group key envelopes, unread 0 —
 * messages from before they joined are not theirs). Call this AFTER
 * announceConversationUpdated so existing members get "updated" and the
 * newcomer only gets "new".
 */
export function announceConversationToMember(conversation, userId) {
  const io = getIO();
  if (!io || !conversation || !userId) return;

  const memberId = String(userId);
  const room = conversationRoom(conversation._id);

  io.in(personalRoom(memberId)).socketsJoin(room);
  io.to(personalRoom(memberId)).emit('conversation:new', {
    conversation: serializeConversation(conversation, {
      unreadCount: 0,
      groupKeysFor: memberId,
    }),
  });
}

/**
 * "conversation:removed" { conversationId, left } to a removed/leaving member,
 * then every one of their sockets leaves the conversation room so messages and
 * socket events stop reaching them. `left: true` marks a voluntary exit (the
 * client skips the "you were removed" notice for it).
 */
export function announceConversationRemoved(conversationId, userId, { left = false } = {}) {
  const io = getIO();
  if (!io || !conversationId || !userId) return;

  const memberId = String(userId);

  io.to(personalRoom(memberId)).emit('conversation:removed', {
    conversationId: conversationId.toString(),
    left: Boolean(left),
  });
  io.in(personalRoom(memberId)).socketsLeave(conversationRoom(conversationId));
}

/** "message:new" for a server-generated message (system activity lines). */
export function announceNewMessage(message) {
  const io = getIO();
  if (!io || !message) return;

  io.to(conversationRoom(message.conversationId)).emit('message:new', {
    message: serializeMessage(message),
  });
}

/**
 * Presence for members that just joined: everyone in the room learns each new
 * member's online state, and each new member receives a snapshot of the whole
 * conversation (their connect-time snapshot was taken before they were a
 * member, so it lacks these people).
 */
export function announcePresenceForNewMembers(conversation, memberIds) {
  const io = getIO();
  if (!io || !conversation) return;

  const allIds = (conversation.members ?? []).map((member) =>
    (member._id ?? member).toString()
  );

  for (const memberId of memberIds) {
    const id = String(memberId);

    io.to(conversationRoom(conversation._id)).emit('presence:update', {
      userId: id,
      online: isOnline(id),
    });
    io.to(personalRoom(id)).emit('presence:snapshot', {
      users: allIds
        .filter((member) => member !== id)
        .map((member) => ({ userId: member, online: isOnline(member) })),
    });
  }
}

/**
 * "conversation:keys" { conversationId, currentKeyVersion, groupKeys } to each
 * member's personal room after a key rotation. Each member receives ONLY their
 * own freshly wrapped envelopes — never another member's (wrapped keys are
 * confidential to their target). Broadcasts learn the new version from
 * "conversation:updated"; the key material itself is never put on the room.
 *
 * `conversation` is the freshly updated doc (lean or hydrated) with `members`,
 * `groupKeys` and `currentKeyVersion`.
 */
export function announceConversationKeys(conversation) {
  const io = getIO();
  if (!io || !conversation) return;

  const version = conversation.currentKeyVersion ?? 1;
  const conversationId = (conversation._id ?? conversation.id).toString();

  for (const member of conversation.members ?? []) {
    const memberId = (member._id ?? member).toString();

    const ownKeys = (conversation.groupKeys ?? [])
      .filter((key) => key.userId.toString() === memberId && key.version === version)
      .map((key) => ({
        userId: key.userId.toString(),
        version: key.version,
        wrappedKey: key.wrappedKey,
        iv: key.iv,
        wrappedBy: key.wrappedBy.toString(),
      }));

    if (ownKeys.length === 0) continue;

    io.to(personalRoom(memberId)).emit('conversation:keys', {
      conversationId,
      currentKeyVersion: version,
      groupKeys: ownKeys,
    });
  }
}

/**
 * "conversation:rotate-key" { conversationId, baseVersion, removedUserId } to
 * the remaining admins after a membership change. The receiving client
 * generates the next group key, wraps it for the current members and POSTs it
 * to /api/conversations/:id/keys. If another admin rotated first, the server
 * answers 409 STALE_KEY_VERSION and the losing client simply keeps the key it
 * receives via "conversation:keys".
 */
export function announceKeyRotationRequested(
  conversation,
  adminIds,
  { removedUserId = null } = {}
) {
  const io = getIO();
  if (!io || !conversation || !adminIds?.length) return;

  const conversationId = (conversation._id ?? conversation.id ?? conversation).toString();
  const baseVersion = conversation.currentKeyVersion ?? 1;

  for (const adminId of adminIds) {
    io.to(personalRoom(String(adminId))).emit('conversation:rotate-key', {
      conversationId,
      baseVersion,
      removedUserId: removedUserId ? String(removedUserId) : null,
    });
  }
}
