import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { Conversation, Message } from '../models/index.js';
import { AppError } from './AppError.js';
import { MESSAGE_FIELDS } from './serialize.js';

export const MAX_CIPHERTEXT_LENGTH = 8000;
export const MAX_IV_LENGTH = 256;
export const MAX_CLIENT_ID_LENGTH = 64;

/**
 * The single definition of "unread for this user": messages from other
 * members that are not in `readBy` yet (deleted-for-everyone and system
 * messages are excluded — "Alex added Sam" must not show a badge). Mirrors the
 * read path in receiptService.js (a read writes `readBy.user`, a read implies
 * `deliveredTo.user`) — keep the two in step.
 */
export function unreadMessagesFilter(userId, { conversationId } = {}) {
  const filter = {
    sender: { $ne: userId },
    deletedForEveryone: { $ne: true },
    type: { $ne: 'system' },
    'readBy.user': { $ne: userId },
  };
  if (conversationId) filter.conversationId = conversationId;
  return filter;
}

/**
 * Shared message creation — used by the REST fallback route now and reusable
 * by the Socket.io layer in the next phase.
 *
 * Callers MUST have verified that `senderId` is a member of `conversation`
 * before calling this function.
 *
 * Deduplicates by sender + clientId: sending the same clientId twice returns
 * the original message (idempotent retries), it never creates a second one.
 *
 * Returns { message, deduplicated }.
 */
export async function createMessage({ conversation, senderId, payload }) {
  const ciphertext = payload?.ciphertext;
  const clientId = typeof payload?.clientId === 'string' ? payload.clientId.trim() : payload?.clientId;
  const iv = payload?.iv ?? null;
  const keyVersion = payload?.keyVersion ?? 1;
  const encrypted = payload?.encrypted ?? true;

  // Defensive validation: the REST route zod-validates, but the socket layer
  // will call this directly, so the service never trusts its input.
  if (
    typeof ciphertext !== 'string' ||
    ciphertext.length === 0 ||
    ciphertext.length > MAX_CIPHERTEXT_LENGTH
  ) {
    throw AppError.badRequest(
      `ciphertext is required and must be at most ${MAX_CIPHERTEXT_LENGTH} characters`,
      'VALIDATION_ERROR'
    );
  }
  if (
    typeof clientId !== 'string' ||
    clientId.length === 0 ||
    clientId.length > MAX_CLIENT_ID_LENGTH
  ) {
    throw AppError.badRequest('clientId is required', 'VALIDATION_ERROR');
  }
  if (encrypted && !iv) {
    throw AppError.badRequest('iv is required when encrypted is true', 'VALIDATION_ERROR');
  }
  if (env.REQUIRE_E2EE && encrypted !== true) {
    throw AppError.badRequest(
      'This server requires end-to-end encrypted messages',
      'ENCRYPTION_REQUIRED'
    );
  }

  const conversationId = conversation._id;

  const existing = await Message.findOne({ sender: senderId, clientId })
    .select(MESSAGE_FIELDS)
    .lean();
  if (existing) {
    if (existing.conversationId.toString() !== conversationId.toString()) {
      throw new AppError(
        'clientId has already been used in another conversation',
        409,
        'CLIENT_ID_REUSED'
      );
    }
    return { message: existing, deduplicated: true };
  }

  let message;
  try {
    message = await Message.create({
      conversationId,
      sender: senderId,
      ciphertext,
      iv,
      keyVersion,
      encrypted,
      clientId,
    });
  } catch (err) {
    // Concurrent retry with the same clientId: return the winning message.
    if (err?.code === 11000) {
      const winner = await Message.findOne({ sender: senderId, clientId })
        .select(MESSAGE_FIELDS)
        .lean();
      if (winner && winner.conversationId.toString() === conversationId.toString()) {
        return { message: winner, deduplicated: true };
      }
      throw new AppError(
        'clientId has already been used in another conversation',
        409,
        'CLIENT_ID_REUSED'
      );
    }
    throw err;
  }

  await Conversation.updateOne(
    { _id: conversationId },
    { $set: { lastMessageAt: message.createdAt, lastMessageId: message._id } }
  );

  return { message, deduplicated: false };
}

/**
 * Server-generated group activity line ("Alex added Sam", "Sam left").
 * System messages are plain text on purpose — they contain no secrets — so
 * they are stored with `encrypted: false` and a null iv, and they are never
 * receipt-tracked (see receiptService.js). `clientId` gets a server-side
 * unique suffix so the sender+clientId dedupe index never collides.
 */
export async function createSystemMessage({ conversationId, senderId, text }) {
  const body = String(text ?? '').trim();
  if (!body) {
    throw AppError.badRequest('System message text is required', 'VALIDATION_ERROR');
  }

  const message = await Message.create({
    conversationId,
    sender: senderId,
    type: 'system',
    ciphertext: body,
    iv: null,
    keyVersion: 1,
    encrypted: false,
    clientId: `system:${randomUUID()}`,
  });

  await Conversation.updateOne(
    { _id: conversationId },
    { $set: { lastMessageAt: message.createdAt, lastMessageId: message._id } }
  );

  return message;
}

/**
 * "Delete for everyone": only the sender may do it. Clears ciphertext + iv
 * and keeps the envelope for the timeline — all without schema validators
 * (an empty ciphertext is the point). Idempotent. Callers pass a preloaded
 * lean message; returns { message, deleted } where `deleted` is false when
 * it was already deleted (so callers know whether to broadcast).
 */
export async function deleteMessageForEveryone({ message, userId }) {
  if (message.type === 'system') {
    throw AppError.forbidden(
      'System messages are part of the group history and cannot be deleted',
      'SYSTEM_MESSAGE'
    );
  }

  if (message.sender.toString() !== userId.toString()) {
    throw AppError.forbidden(
      'Only the sender can delete this message for everyone',
      'NOT_MESSAGE_SENDER'
    );
  }

  if (message.deletedForEveryone) {
    return { message, deleted: false };
  }

  const updated = await Message.findByIdAndUpdate(
    message._id,
    { $set: { deletedForEveryone: true, ciphertext: '', iv: null } },
    { returnDocument: 'after' }
  )
    .select(MESSAGE_FIELDS)
    .lean();

  return { message: updated, deleted: true };
}

export default createMessage;
