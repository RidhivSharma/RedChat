// ============================================================================
// ChatWave Socket.io client — the single place realtime code lives (client
// rule). It:
//   - creates the authenticated socket (auth: { token }, same JWT as REST)
//   - owns the connect/disconnect lifecycle (auto-reconnect is on)
//   - wraps every emit the UI needs in an acknowledgement helper that resolves
//     with the ack's `data` and rejects with a SocketError ({ message, code })
// ============================================================================

import { io } from 'socket.io-client';

// Where the Socket.io server lives:
//   - VITE_SOCKET_URL set (local dev: http://localhost:5000) → used as given.
//   - development without it → the local API, plus the warning below.
//   - production without it → the origin that served the page. That is the
//     deployed layout: one Vercel project (services mode) whose top-level
//     rewrite sends /socket.io/* on this same domain to the API service.
const configuredSocketUrl = import.meta.env.VITE_SOCKET_URL;

const SOCKET_URL = configuredSocketUrl
  ? configuredSocketUrl.replace(/\/+$/, '')
  : import.meta.env.DEV
    ? 'http://localhost:5000'
    : undefined;

if (import.meta.env.DEV && !configuredSocketUrl) {
  console.warn(
    '[ChatWave] VITE_SOCKET_URL is not set — realtime falls back to http://localhost:5000. ' +
      'Copy client/.env.example to client/.env and restart the dev server.'
  );
}

/** Server acknowledgements answer within this window before we give up. */
export const ACK_TIMEOUT_MS = 10_000;

export class SocketError extends Error {
  constructor(message, code = 'SOCKET_ERROR') {
    super(message);
    this.name = 'SocketError';
    this.code = code;
  }
}

/**
 * Builds the socket for one session. autoConnect is off: the provider decides
 * when to connect (only while logged in) and disconnects on logout.
 */
export function createSocket(token) {
  // SOCKET_URL === undefined means "same origin as the page" in socket.io-client.
  return io(SOCKET_URL, {
    auth: { token },
    autoConnect: false,
    // Vercel Functions (public beta) only upgrade websocket connections —
    // HTTP long-polling cannot work in their serverless model, so the
    // websocket transport is forced. This works on every host (local dev,
    // Render/Railway, Vercel): long-polling fallback is the only thing lost.
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 800,
    reconnectionDelayMax: 6000,
    randomizationFactor: 0.4,
    timeout: ACK_TIMEOUT_MS,
  });
}

export function connectSocket(socket) {
  if (socket && !socket.connected) socket.connect();
}

export function disconnectSocket(socket) {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
}

/**
 * Emits `event` and resolves with the ack's `data`.
 * Rejects with SocketError when offline, when the ack times out or when the
 * server answers `{ ok: false, error: { message, code } }`.
 */
export function emitWithAck(socket, event, payload, { timeout = ACK_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (!socket || !socket.connected) {
      reject(
        new SocketError(
          'You appear to be offline — the app will retry when the connection is back.',
          'OFFLINE'
        )
      );
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new SocketError('The server did not respond in time.', 'ACK_TIMEOUT'));
    }, timeout);

    socket.emit(event, payload, (ack) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (ack && ack.ok) {
        resolve(ack.data ?? {});
        return;
      }
      reject(
        new SocketError(
          ack?.error?.message || 'The request failed, please try again.',
          ack?.error?.code || 'REQUEST_FAILED'
        )
      );
    });
  });
}

/** message:send { conversationId, clientId, ciphertext, iv, keyVersion, encrypted }. */
export function sendMessage(socket, payload) {
  return emitWithAck(socket, 'message:send', payload);
}

/** message:delete { messageId } — sender only, "delete for everyone". */
export function deleteMessage(socket, messageId) {
  return emitWithAck(socket, 'message:delete', { messageId });
}

/**
 * message:delivered { conversationId, messageIds } — the recipient confirms
 * receipt. Failures are ignored by the UI: the server also marks delivery for
 * online members and catches up on the next connect.
 */
export function sendMessageDelivered(socket, payload) {
  return emitWithAck(socket, 'message:delivered', payload, { timeout: 5000 });
}

/**
 * message:read { conversationId, upToMessageId } — the recipient read
 * everything up to that message (a read implies delivered server-side).
 */
export function sendMessageRead(socket, payload) {
  return emitWithAck(socket, 'message:read', payload, { timeout: 5000 });
}

/** typing:start { conversationId } — failures are ignored by the UI. */
export function startTyping(socket, conversationId) {
  return emitWithAck(socket, 'typing:start', { conversationId }, { timeout: 5000 });
}

/** typing:stop { conversationId }. */
export function stopTyping(socket, conversationId) {
  return emitWithAck(socket, 'typing:stop', { conversationId }, { timeout: 5000 });
}

export default createSocket;
