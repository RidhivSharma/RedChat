import { z } from 'zod';
import { AppError } from '../utils/AppError.js';
import { loadConversationForMember } from '../utils/conversationAccess.js';
import { parsePayload, respond, respondError } from './helpers.js';
import { createSlidingWindowLimiter } from './rateLimit.js';
import { conversationRoom, personalRoom } from './rooms.js';

const typingSchema = z.object({
  conversationId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'must be a 24-character hex id'),
});

/** Typing events are chatty: cap spam well above legitimate usage. */
const TYPING_LIMIT = { limit: 40, windowMs: 10_000 };

/** Registers typing:start / typing:stop for one socket. */
export function registerTypingHandlers(io, socket) {
  const limiter = createSlidingWindowLimiter(TYPING_LIMIT);
  const lastState = new Map(); // conversationId -> boolean (dedupe repeats)

  function handle(flag) {
    return async (payload, ack) => {
      try {
        const data = parsePayload(typingSchema, payload);

        if (!limiter()) {
          throw new AppError('Too many typing events — please slow down', 429, 'RATE_LIMITED');
        }

        await loadConversationForMember(data.conversationId, socket.data.userId);

        // Repeats of the same state are cheap no-ops.
        if (lastState.get(data.conversationId) === flag) {
          respond(ack, {});
          return;
        }
        lastState.set(data.conversationId, flag);

        // Deliver to the other members only: skip the sender's own sockets.
        socket
          .to(conversationRoom(data.conversationId))
          .except(personalRoom(socket.data.userId))
          .emit('typing', {
            conversationId: data.conversationId,
            userId: socket.data.userId,
            isTyping: flag,
          });

        respond(ack, {});
      } catch (err) {
        respondError(ack, err, flag ? 'typing:start' : 'typing:stop');
      }
    };
  }

  socket.on('typing:start', handle(true));
  socket.on('typing:stop', handle(false));
}
