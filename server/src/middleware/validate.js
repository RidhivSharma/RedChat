import { AppError } from '../utils/AppError.js';

/**
 * Validates req.body against a zod schema. On success the parsed (and
 * transformed) value replaces req.body; on failure a 400 with a readable
 * message is forwarded to the central error handler.
 */
export function validateBody(schema) {
  return function validateBodyMiddleware(req, _res, next) {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const first = result.error.issues[0];
      const field = first?.path?.join('.') || 'body';
      const message = first ? `${field}: ${first.message}` : 'Invalid request body';
      next(AppError.badRequest(message, 'VALIDATION_ERROR'));
      return;
    }

    req.body = result.data;
    next();
  };
}

/**
 * Validates req.query against a zod schema. Express 5 exposes req.query as a
 * getter, so the parsed value is stored on req.validatedQuery instead.
 */
export function validateQuery(schema) {
  return function validateQueryMiddleware(req, _res, next) {
    const result = schema.safeParse(req.query);

    if (!result.success) {
      const first = result.error.issues[0];
      const field = first?.path?.join('.') || 'query';
      const message = first ? `${field}: ${first.message}` : 'Invalid query parameters';
      next(AppError.badRequest(message, 'VALIDATION_ERROR'));
      return;
    }

    req.validatedQuery = result.data;
    next();
  };
}

export default validateBody;
