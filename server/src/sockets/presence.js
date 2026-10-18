import { Conversation, User } from '../models/index.js';
import { conversationRoom, personalRoom } from './rooms.js';
import { deliverPendingMessages } from './receipts.js';

/**
 * In-memory presence registry: userId -> Set of socket ids. Several sockets
 * mean several tabs/devices; a user is online while the set is non-empty.
 * Single-process only — swap for a shared store/Redis adapter when the app
 * scales horizontally.
 */
const socketsByUser = new Map();

/** Registers a socket; returns true when it was the user's first connection. */
export function addSocket(userId, socketId) {
  const key = String(userId);
  let socketIds = socketsByUser.get(key);
  if (!socketIds) {
    socketIds = new Set();
    socketsByUser.set(key, socketIds);
  }
  const firstConnection = socketIds.size === 0;
  socketIds.add(socketId);
  return firstConnection;
}

/** Removes a socket; returns true when it was the user's last connection. */
export function removeSocket(userId, socketId) {
  const key = String(userId);
  const socketIds = socketsByUser.get(key);
  if (!socketIds) return false;

  socketIds.delete(socketId);
  if (socketIds.size > 0) return false;

  socketsByUser.delete(key);
  return true;
}

export function isOnline(userId) {
  return socketsByUser.has(String(userId));
}

/**
 * Conversation ids to join and the ids of everyone the user shares a
 * conversation with (their presence audience), in one query.
 */
async function loadConversationNetwork(userId) {
  const conversations = await Conversation.find({ members: userId })
    .select('_id members')
    .lean();

  const conversationIds = [];
  const sharedUserIds = new Set();

  for (const conversation of conversations) {
    conversationIds.push(conversation._id.toString());
    for (const member of conversation.members) {
      const memberId = member.toString();
      if (memberId !== userId) sharedUserIds.add(memberId);
    }
  }

  return { conversationIds, sharedUserIds: [...sharedUserIds] };
}

function broadcastPresenceUpdate(io, targetUserIds, payload) {
  for (const targetUserId of targetUserIds) {
    io.to(personalRoom(targetUserId)).emit('presence:update', payload);
  }
}

/**
 * Connection handler: joins the personal room and every conversation room,
 * marks the user online (broadcast to conversation partners on the first
 * socket only) and sends the connecting socket a presence snapshot.
 */
export async function handleConnect(io, socket) {
  const userId = socket.data.userId;
  socket.join(personalRoom(userId));

  const firstConnection = addSocket(userId, socket.id);

  // Register the connection before the (async) network load so a very fast
  // disconnect still cleans up the presence entry.
  let network = { conversationIds: [], sharedUserIds: [] };
  try {
    network = await loadConversationNetwork(userId);
  } catch (err) {
    console.error('[presence] failed to load conversations:', err?.message ?? err);
  }

  // The client may have disconnected while we were loading; the disconnect
  // handler already removed the presence entry in that case.
  if (!socket.connected) return;

  for (const conversationId of network.conversationIds) {
    socket.join(conversationRoom(conversationId));
  }

  socket.emit('presence:snapshot', {
    users: network.sharedUserIds.map((id) => ({ userId: id, online: isOnline(id) })),
  });

  if (firstConnection) {
    broadcastPresenceUpdate(io, network.sharedUserIds, { userId, online: true });
  }

  // Delivery catch-up: the socket is in its conversation rooms now, so the
  // receipt updates reach the senders. Errors must not break the presence
  // handshake that already happened above.
  try {
    await deliverPendingMessages(io, userId);
  } catch (err) {
    console.error('[receipts] delivery catch-up failed:', err?.message ?? err);
  }
}

/**
 * Disconnect handler: when the user's last socket goes away, persist
 * lastSeen and broadcast { userId, online: false, lastSeen }.
 */
export async function handleDisconnect(io, socket) {
  const userId = socket.data.userId;
  if (!userId) return;
  if (!removeSocket(userId, socket.id)) return;

  const lastSeen = new Date();
  try {
    await User.updateOne({ _id: userId }, { $set: { lastSeen } });
  } catch (err) {
    console.error('[presence] failed to update lastSeen:', err?.message ?? err);
  }

  let sharedUserIds = [];
  try {
    ({ sharedUserIds } = await loadConversationNetwork(userId));
  } catch (err) {
    console.error('[presence] failed to load conversation partners:', err?.message ?? err);
  }

  broadcastPresenceUpdate(io, sharedUserIds, { userId, online: false, lastSeen });
}
