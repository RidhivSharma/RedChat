import { z } from 'zod';
import { Message } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { loadConversationForMember } from '../utils/conversationAccess.js';
import {
  deliverPendingMessagesForUser,
  markMessagesDelivered,
  markMessagesReadUpTo,
} from '../utils/receiptService.js';
import { serializeMessageStatus } from '../utils/serialize.js';
import { parsePayload, respond, respondError } from './helpers.js';
import { createSlidingWindowLimiter } from './rateLimit.js';
import { conversationRoom } from './rooms.js';

const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'must be a 24-character hex id');

/**
 * message:delivered { conversationId, messageIds? }
 * messageIds omitted → every undelivered message of the conversation.
 */
const deliveredSchema = z.object({
  conversationId: objectIdSchema,
  messageIds: z.array(objectIdSchema).min(1).max(200).optional(),
});

/** message:read { conversationId, upToMessageId } — everything up to the point. */
const readSchema = z.object({
  conversationId: objectIdSchema,
  upToMessageId: objectIdSchema,
});

/** Receipt events are frequent but small: cap spam well above real usage. */
export const RECEIPT_EVENT_LIMIT = { limit: 60, windowMs: 10_000 };

/** Emits one message:status per message to that message's conversation room. */
export function emitStatusUpdates(io, messages) {
  for (const message of messages) {
    io.to(conversationRoom(message.conversationId)).emit(
      'message:status',
      serializeMessageStatus(message)
    );
  }
}

/**
 * Connect-time delivery catch-up (called by the presence handler after the
 * socket joined its rooms): marks every undelivered message addressed to the
 * connecting user as delivered and tells the conversation rooms, so senders'
 * ticks turn "delivered" without them being online when the recipient
 * reconnects.
 */
export async function deliverPendingMessages(io, userId) {
  const updated = await deliverPendingMessagesForUser(userId);
  emitStatusUpdates(io, updated);
  return updated.length;
}

/** Registers message:delivered and message:read for one socket. */
export function registerReceiptHandlers(io, socket) {
  const limiter = createSlidingWindowLimiter(RECEIPT_EVENT_LIMIT);

  socket.on('message:delivered', async (payload, ack) => {
    try {
      const data = parsePayload(deliveredSchema, payload);

      if (!limiter()) {
        throw new AppError('Too many receipt events — please slow down', 429, 'RATE_LIMITED');
      }

      await loadConversationForMember(data.conversationId, socket.data.userId);

      const updated = await markMessagesDelivered({
        conversationId: data.conversationId,
        userId: socket.data.userId,
        messageIds: data.messageIds,
      });
      emitStatusUpdates(io, updated);

      respond(ack, { delivered: updated.length });
    } catch (err) {
      respondError(ack, err, 'message:delivered');
    }
  });

  socket.on('message:read', async (payload, ack) => {
    try {
      const data = parsePayload(readSchema, payload);

      if (!limiter()) {
        throw new AppError('Too many receipt events — please slow down', 429, 'RATE_LIMITED');
      }

      await loadConversationForMember(data.conversationId, socket.data.userId);

      const upToMessage = await Message.findById(data.upToMessageId)
        .select('conversationId createdAt')
        .lean();
      if (!upToMessage || upToMessage.conversationId.toString() !== data.conversationId) {
        throw AppError.badRequest(
          'upToMessageId does not belong to this conversation',
          'VALIDATION_ERROR'
        );
      }

      const { at, readCount, deliveredCount } = await markMessagesReadUpTo({
        conversationId: data.conversationId,
        userId: socket.data.userId,
        upToMessage,
      });

      // One batched event for the whole read (per-message message:status
      // updates would be an event storm after a long absence).
      io.to(conversationRoom(data.conversationId)).emit('messages:read', {
        conversationId: data.conversationId,
        userId: socket.data.userId,
        upToMessageId: data.upToMessageId,
        upToMessageAt: upToMessage.createdAt,
        at,
        readCount,
        deliveredCount,
      });

      respond(ack, { readCount, deliveredCount, at });
    } catch (err) {
      respondError(ack, err, 'message:read');
    }
  });
}
