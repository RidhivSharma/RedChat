import { z } from 'zod';
import { Message } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { loadConversationForMember } from '../utils/conversationAccess.js';
import {
  createMessage,
  deleteMessageForEveryone,
  MAX_CIPHERTEXT_LENGTH,
  MAX_CLIENT_ID_LENGTH,
  MAX_IV_LENGTH,
} from '../utils/messageService.js';
import { serializeMessage } from '../utils/serialize.js';
import { parsePayload, respond, respondError } from './helpers.js';
import { isOnline } from './presence.js';
import { createSlidingWindowLimiter } from './rateLimit.js';
import { conversationRoom } from './rooms.js';

const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'must be a 24-character hex id');

const sendSchema = z
  .object({
    conversationId: objectIdSchema,
    ciphertext: z
      .string()
      .min(1, 'ciphertext is required')
      .max(
        MAX_CIPHERTEXT_LENGTH,
        `ciphertext must be at most ${MAX_CIPHERTEXT_LENGTH} characters`
      ),
    // Empty iv is allowed for plaintext-phase payloads (encrypted: false);
    // the superRefine below still requires a non-empty iv when encrypted.
    iv: z.string().max(MAX_IV_LENGTH).optional(),
    keyVersion: z.number().int().positive().max(10_000).default(1),
    encrypted: z.boolean().default(true),
    clientId: z
      .string()
      .trim()
      .min(1, 'clientId is required')
      .max(MAX_CLIENT_ID_LENGTH, `clientId must be at most ${MAX_CLIENT_ID_LENGTH} characters`),
  })
  .superRefine((data, ctx) => {
    if (data.encrypted && !data.iv) {
      ctx.addIssue({
        code: 'custom',
        path: ['iv'],
        message: 'iv is required when encrypted is true',
      });
    }
  });

const deleteSchema = z.object({
  messageId: objectIdSchema,
});

/** Per-socket spam protection for message:send. */
export const MESSAGE_SEND_LIMIT = { limit: 20, windowMs: 10_000 };

/**
 * Marks the message as delivered for every recipient that is online right
 * now. Returns the message (plain object) with the updated deliveredTo.
 */
async function markDeliveredForOnlineMembers(conversation, message) {
  const senderId = message.sender.toString();
  const alreadyDelivered = new Set(
    (message.deliveredTo ?? []).map((receipt) => receipt.user.toString())
  );

  const entries = [];
  for (const member of conversation.members) {
    const memberId = (member._id ?? member).toString();
    if (memberId === senderId || alreadyDelivered.has(memberId) || !isOnline(memberId)) {
      continue;
    }
    entries.push({ user: memberId, at: new Date() });
  }

  if (entries.length === 0) return message;

  await Message.updateOne({ _id: message._id }, { $push: { deliveredTo: { $each: entries } } });

  const base = typeof message.toObject === 'function' ? message.toObject() : message;
  return { ...base, deliveredTo: [...(message.deliveredTo ?? []), ...entries] };
}

/** Registers the realtime message events for one socket. */
export function registerMessageHandlers(io, socket) {
  const limiter = createSlidingWindowLimiter(MESSAGE_SEND_LIMIT);

  socket.on('message:send', async (payload, ack) => {
    try {
      const data = parsePayload(sendSchema, payload);

      if (!limiter()) {
        throw new AppError(
          'You are sending messages too quickly — please slow down',
          429,
          'RATE_LIMITED'
        );
      }

      const conversation = await loadConversationForMember(
        data.conversationId,
        socket.data.userId
      );

      const { message, deduplicated } = await createMessage({
        conversation,
        senderId: socket.data.userId,
        payload: data,
      });

      if (deduplicated) {
        // The message already exists (retry) — ack it, do not re-broadcast.
        respond(ack, { message: serializeMessage(message) });
        return;
      }

      const delivered = await markDeliveredForOnlineMembers(conversation, message);
      const output = serializeMessage(delivered);

      io.to(conversationRoom(data.conversationId)).emit('message:new', { message: output });
      respond(ack, { message: output });
    } catch (err) {
      respondError(ack, err, 'message:send');
    }
  });

  socket.on('message:delete', async (payload, ack) => {
    try {
      const data = parsePayload(deleteSchema, payload);

      const message = await Message.findById(data.messageId)
        .select('sender conversationId deletedForEveryone type')
        .lean();
      if (!message) {
        throw new AppError('Message not found', 404, 'MESSAGE_NOT_FOUND');
      }

      // Membership first, then sender-only (both enforced inside the shared
      // service for the sender check).
      await loadConversationForMember(message.conversationId, socket.data.userId);

      const { message: updated, deleted } = await deleteMessageForEveryone({
        message,
        userId: socket.data.userId,
      });

      if (deleted) {
        io.to(conversationRoom(message.conversationId)).emit('message:deleted', {
          conversationId: message.conversationId.toString(),
          messageId: data.messageId,
        });
      }

      respond(ack, { message: serializeMessage(updated) });
    } catch (err) {
      respondError(ack, err, 'message:delete');
    }
  });
}
