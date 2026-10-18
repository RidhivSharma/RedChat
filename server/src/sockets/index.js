import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { User } from '../models/index.js';
import { OBJECT_ID_RE } from '../utils/conversationAccess.js';
import { registerMessageHandlers } from './messages.js';
import { handleConnect, handleDisconnect } from './presence.js';
import { registerReceiptHandlers } from './receipts.js';
import { registerTypingHandlers } from './typing.js';

let io = null;

/** The attached Socket.io server, or null when it was never attached. */
export function getIO() {
  return io;
}

function authError(message, code) {
  const error = new Error(message);
  error.data = { code };
  return error;
}

/**
 * io.use middleware: every socket authenticates in the handshake with
 * `auth: { token }` (the same JWT the REST API uses). The verified user id is
 * stored in socket.data.userId — event handlers never trust the client.
 * Rejections arrive as connect_error with `err.data.code`.
 */
async function authenticate(socket, next) {
  const token = socket.handshake.auth?.token;

  if (typeof token !== 'string' || token.length === 0) {
    next(authError('Authentication required', 'AUTH_REQUIRED'));
    return;
  }

  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET);
  } catch (err) {
    if (err?.name === 'TokenExpiredError') {
      next(authError('Session expired, please log in again', 'TOKEN_EXPIRED'));
      return;
    }
    next(authError('Invalid token', 'INVALID_TOKEN'));
    return;
  }

  if (!payload?.sub || !OBJECT_ID_RE.test(payload.sub)) {
    next(authError('Invalid token', 'INVALID_TOKEN'));
    return;
  }

  let user;
  try {
    user = await User.findById(payload.sub).select('_id').lean();
  } catch (err) {
    next(authError('Authentication failed', 'AUTH_FAILED'));
    return;
  }

  if (!user) {
    next(authError('User no longer exists', 'INVALID_TOKEN'));
    return;
  }

  socket.data.userId = user._id.toString();
  next();
}

/**
 * Attaches Socket.io to the HTTP server: CORS limited to CLIENT_URL, JWT
 * handshake authentication, presence tracking, room joins and the realtime
 * event handlers. Called once from src/server.js.
 */
export function attachSockets(httpServer) {
  if (io) throw new Error('Socket.io is already attached');

  io = new Server(httpServer, {
    cors: { origin: env.CLIENT_URL, credentials: true },
  });

  io.use(authenticate);

  io.on('connection', (socket) => {
    registerMessageHandlers(io, socket);
    registerReceiptHandlers(io, socket);
    registerTypingHandlers(io, socket);

    handleConnect(io, socket).catch((err) => {
      console.error('[sockets] connect handling failed:', err?.message ?? err);
    });

    socket.on('disconnect', () => {
      handleDisconnect(io, socket).catch((err) => {
        console.error('[sockets] disconnect handling failed:', err?.message ?? err);
      });
    });
  });

  return io;
}
