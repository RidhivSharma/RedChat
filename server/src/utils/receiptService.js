import { Conversation, Message } from '../models/index.js';
import { MESSAGE_FIELDS } from './serialize.js';

/**
 * Delivery/read receipts — the single place `deliveredTo` / `readBy` rows are
 * written. Used by the Socket.io layer (message:delivered / message:read and
 * the connect-time catch-up) and mirrored by the unread count queries
 * (unreadMessagesFilter in messageService.js).
 *
 * Rules:
 *   - never receipt your own messages (sender is skipped everywhere),
 *   - deleted-for-everyone messages are skipped (their receipts are invisible),
 *   - a read implies delivered (readUpTo delivers and reads in one pass),
 *   - "up to a point" uses createdAt with an `_id` tiebreaker — the same
 *     ordering history pagination uses.
 */

/**
 * Most messages one connection's delivery catch-up marks. A reconnecting
 * client with a long backlog marks the next batch on the next connect, which
 * keeps one connect from flooding the conversation rooms with events.
 */
export const MAX_CONNECT_DELIVERY = 500;

/** Undelivered messages addressed to this user, oldest first. */
async function findPendingDeliveryIds({ userId, conversationIds, filter = {}, limit }) {
  const query = Message.find({
    conversationId: { $in: conversationIds },
    sender: { $ne: userId },
    deletedForEveryone: { $ne: true },
    // System activity lines are never receipt-tracked.
    type: { $ne: 'system' },
    'deliveredTo.user': { $ne: userId },
    ...filter,
  })
    .select('_id')
    .sort({ createdAt: 1, _id: 1 });

  if (limit) query.limit(limit);
  return (await query.lean()).map((message) => message._id);
}

/**
 * Marks the given message ids as delivered for `userId` and returns the
 * updated messages (lean, MESSAGE_FIELDS) so the caller can emit
 * message:status. The `'deliveredTo.user': { $ne: userId }` condition lives in
 * the update filter, so concurrent duplicate events cannot push twice.
 */
async function deliverByIds(userId, ids) {
  if (ids.length === 0) return [];

  const at = new Date();
  await Message.updateMany(
    { _id: { $in: ids }, 'deliveredTo.user': { $ne: userId } },
    { $push: { deliveredTo: { user: userId, at } } }
  );

  return Message.find({ _id: { $in: ids } })
    .select(MESSAGE_FIELDS)
    .sort({ createdAt: 1, _id: 1 })
    .lean();
}

/**
 * Connect-time catch-up: every message addressed to `userId` that is still
 * undelivered gets a deliveredTo entry. Returns the updated messages.
 */
export async function deliverPendingMessagesForUser(
  userId,
  { limit = MAX_CONNECT_DELIVERY } = {}
) {
  const conversationIds = (
    await Conversation.find({ members: userId }).select('_id').lean()
  ).map((conversation) => conversation._id);
  if (conversationIds.length === 0) return [];

  const ids = await findPendingDeliveryIds({ userId, conversationIds, limit });
  return deliverByIds(userId, ids);
}

/**
 * message:delivered: marks the given messages (or every undelivered message
 * of the conversation when `messageIds` is omitted) as delivered for `userId`.
 * Messages outside the conversation are ignored silently.
 */
export async function markMessagesDelivered({ conversationId, userId, messageIds }) {
  const filter = {};
  if (Array.isArray(messageIds) && messageIds.length > 0) {
    filter._id = { $in: messageIds };
  }

  const ids = await findPendingDeliveryIds({
    userId,
    conversationIds: [conversationId],
    filter,
  });
  return deliverByIds(userId, ids);
}

/**
 * message:read: every message from other members at or before `upToMessage`
 * (a lean `{ _id, createdAt }` of the read point) is marked read for `userId`.
 * The same pass fills in missing deliveredTo rows — a read implies delivered.
 *
 * Returns counts plus the timestamp shared by the new receipts.
 */
export async function markMessagesReadUpTo({ conversationId, userId, upToMessage }) {
  const at = new Date();
  const createdAt = upToMessage.createdAt;
  const upToId = upToMessage._id;

  const upToFilter = {
    conversationId,
    sender: { $ne: userId },
    deletedForEveryone: { $ne: true },
    // "Alex added Sam" needs no delivered/read rows.
    type: { $ne: 'system' },
    $or: [{ createdAt: { $lt: createdAt } }, { createdAt, _id: { $lte: upToId } }],
  };

  const delivered = await Message.updateMany(
    { ...upToFilter, 'deliveredTo.user': { $ne: userId } },
    { $push: { deliveredTo: { user: userId, at } } }
  );

  const read = await Message.updateMany(
    { ...upToFilter, 'readBy.user': { $ne: userId } },
    { $push: { readBy: { user: userId, at } } }
  );

  return {
    at,
    deliveredCount: delivered.modifiedCount ?? 0,
    readCount: read.modifiedCount ?? 0,
  };
}
