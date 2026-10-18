import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { User } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

/**
 * Verifies the "Authorization: Bearer <jwt>" header, loads the matching user
 * and attaches it as req.user. Answers 401 with a distinct code for missing,
 * invalid and expired tokens.
 */
export const requireAuth = asyncHandler(async (req, _res, next) => {
  const header = req.get('authorization') ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) {
    throw new AppError('Authentication required', 401, 'AUTH_REQUIRED');
  }

  const token = header.slice(7).trim();
  if (!token) {
    throw new AppError('Authentication required', 401, 'AUTH_REQUIRED');
  }

  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET);
  } catch (err) {
    if (err?.name === 'TokenExpiredError') {
      throw new AppError('Session expired, please log in again', 401, 'TOKEN_EXPIRED');
    }
    throw new AppError('Invalid token', 401, 'INVALID_TOKEN');
  }

  if (!payload?.sub || !OBJECT_ID_RE.test(payload.sub)) {
    throw new AppError('Invalid token', 401, 'INVALID_TOKEN');
  }

  const user = await User.findById(payload.sub);
  if (!user) {
    throw new AppError('User no longer exists', 401, 'INVALID_TOKEN');
  }

  req.user = user;
  next();
});
