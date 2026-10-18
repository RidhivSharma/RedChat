import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

/**
 * Signs an auth token for a user id. The id travels only in the signed "sub"
 * claim — clients never get to decide who they are.
 */
export function signAuthToken(userId) {
  return jwt.sign({ sub: userId.toString() }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  });
}

export default signAuthToken;
