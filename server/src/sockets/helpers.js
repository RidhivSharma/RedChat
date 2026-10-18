import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';

/**
 * Validates a socket payload with zod. On failure throws the same
 * "field: message" VALIDATION_ERROR shape the REST API uses.
 */
export function parsePayload(schema, payload) {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const first = result.error.issues[0];
    const field = first?.path?.join('.') || 'payload';
    throw AppError.badRequest(first ? `${field}: ${first.message}` : 'Invalid payload', 'VALIDATION_ERROR');
  }
  return result.data;
}

/** Sends a successful ack. Missing acks (fire-and-forget emits) are fine. */
export function respond(ack, data = {}) {
  if (typeof ack === 'function') {
    ack({ ok: true, data });
  }
}

/**
 * Sends an error ack `{ ok: false, error: { message, code } }`. Operational
 * errors (AppError) keep their message/code; anything else is logged and
 * reported generically.
 */
export function respondError(ack, err, context = 'event') {
  const operational = err instanceof AppError || err?.isOperational === true;

  if (!operational) {
    // Full error stays server-side; the client only receives the generic ack.
    logger.error(`socket event failed: ${context}`, { error: err });
  }

  const error = operational
    ? { message: err.message, code: err.code }
    : { message: 'Something went wrong, please try again', code: 'INTERNAL_ERROR' };

  if (typeof ack === 'function') {
    ack({ ok: false, error });
  }
}
