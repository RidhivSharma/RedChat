// Plain-object serializers shared by the REST controllers and (next phase) the
// Socket.io layer. They only read fields, so they work for both hydrated
// Mongoose documents and lean() results.

/** Public user fields — never passwordHash / encryptedPrivateKey. */
export const MEMBER_FIELDS = 'username displayName avatarColor publicKey lastSeen';

/** Everything a message response needs, for projections/lean() queries. */
export const MESSAGE_FIELDS =
  'conversationId sender ciphertext iv keyVersion encrypted type clientId deliveredTo readBy deletedForEveryone createdAt';

export function serializeUser(user) {
  if (!user) return null;
  const rawId = user._id ?? user.id;
  return {
    id: rawId.toString(),
    username: user.username,
    displayName: user.displayName,
    avatarColor: user.avatarColor,
    publicKey: user.publicKey ?? null,
    lastSeen: user.lastSeen ?? null,
  };
}

export function serializeMessage(message) {
  // Deleted-for-everyone messages never expose their content.
  const hidden = message.deletedForEveryone === true;
  return {
    id: message._id.toString(),
    conversationId: message.conversationId.toString(),
    sender: message.sender.toString(),
    type: message.type === 'system' ? 'system' : 'user',
    ciphertext: hidden ? null : message.ciphertext,
    iv: hidden ? null : (message.iv ?? null),
    keyVersion: message.keyVersion ?? 1,
    encrypted: message.encrypted !== false,
    clientId: message.clientId,
    deletedForEveryone: hidden,
    deliveredTo: (message.deliveredTo ?? []).map((receipt) => ({
      user: receipt.user.toString(),
      at: receipt.at,
    })),
    readBy: (message.readBy ?? []).map((receipt) => ({
      user: receipt.user.toString(),
      at: receipt.at,
    })),
    createdAt: message.createdAt,
  };
}

/**
 * Receipt update for one message — the `message:status` socket payload
 * ({ conversationId, messageId, deliveredTo, readBy }).
 */
export function serializeMessageStatus(message) {
  const serialized = serializeMessage(message);
  return {
    conversationId: serialized.conversationId,
    messageId: serialized.id,
    deliveredTo: serialized.deliveredTo,
    readBy: serialized.readBy,
  };
}

/**
 * Conversation response shape. `members` must be populated (lean or hydrated).
 * groupKeys are only returned for the requesting user (they are encrypted for
 * that specific member).
 *
 * `unreadCount` is only included when the caller computed it for a specific
 * viewer — broadcasts like conversation:updated must not reset the recipients'
 * badges to 0.
 *
 * `lastMessage` (optionally a serialized/lean message) is attached when the
 * caller knows it; the client decrypts the preview locally — the server never
 * stores plaintext previews.
 */
export function serializeConversation(
  conversation,
  { unreadCount, groupKeysFor = null, lastMessage } = {}
) {
  const result = {
    id: conversation._id.toString(),
    type: conversation.type,
    name: conversation.name ?? '',
    members: (conversation.members ?? []).map(serializeUser).filter(Boolean),
    admins: (conversation.admins ?? []).map((id) => id.toString()),
    createdBy: conversation.createdBy ? conversation.createdBy.toString() : null,
    currentKeyVersion: conversation.currentKeyVersion ?? 1,
    lastMessageAt: conversation.lastMessageAt ?? null,
    lastMessageId: conversation.lastMessageId ? conversation.lastMessageId.toString() : null,
    createdAt: conversation.createdAt,
  };

  if (unreadCount !== undefined) {
    result.unreadCount = unreadCount;
  }

  if (lastMessage !== undefined) {
    result.lastMessage = lastMessage ? serializeMessage(lastMessage) : null;
  }

  if (groupKeysFor) {
    const requesterId = groupKeysFor.toString();
    result.groupKeys = (conversation.groupKeys ?? [])
      .filter((key) => key.userId.toString() === requesterId)
      .map((key) => ({
        userId: key.userId.toString(),
        version: key.version,
        wrappedKey: key.wrappedKey,
        iv: key.iv,
        wrappedBy: key.wrappedBy.toString(),
      }));
  }

  return result;
}
