import { createContext, useEffect, useMemo, useState } from 'react';
import { clearToken, markSessionExpired, UNAUTHORIZED_EVENT } from '../services/api.js';
import { connectSocket, createSocket, disconnectSocket } from '../services/socket.js';
import { useAuth } from '../hooks/useAuth.js';

export const SocketContext = createContext(null);

/**
 * Owns the Socket.io connection for the logged-in session:
 *   - connects with `auth: { token }` as soon as a token exists
 *   - reconnects automatically (socket.io reconnection is enabled in
 *     services/socket.js); `connectionCount` increments on every success so
 *     the chat layer can refetch messages missed while offline
 *   - disconnects and forgets the socket on logout (no token)
 *   - mirrors handshake auth failures into the same "session expired" path the
 *     REST layer uses on a 401
 *
 * Exposes { socket, status, connectionCount } with
 * status: "connecting" | "connected" | "disconnected".
 */
export function SocketProvider({ children }) {
  const { token } = useAuth();
  const [socket, setSocket] = useState(null);
  const [status, setStatus] = useState(token ? 'connecting' : 'disconnected');
  const [connectionCount, setConnectionCount] = useState(0);

  useEffect(() => {
    if (!token) {
      setSocket(null);
      setStatus('disconnected');
      return undefined;
    }

    const instance = createSocket(token);
    setSocket(instance);
    setStatus('connecting');

    function handleConnect() {
      setStatus('connected');
      setConnectionCount((count) => count + 1);
    }

    function handleDisconnect() {
      // Includes the deliberate disconnect on logout/unmount.
      setStatus('disconnected');
    }

    function handleReconnectAttempt() {
      setStatus((current) => (current === 'connected' ? current : 'connecting'));
    }

    function handleConnectError(error) {
      const code = error?.data?.code;
      if (code === 'TOKEN_EXPIRED' || code === 'INVALID_TOKEN' || code === 'AUTH_REQUIRED') {
        // Same policy as a REST 401: drop the session and bounce to /login.
        markSessionExpired();
        clearToken();
        window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
        setStatus('disconnected');
        return;
      }
      // Transport failure — socket.io keeps retrying in the background.
      setStatus('connecting');
    }

    instance.on('connect', handleConnect);
    instance.on('disconnect', handleDisconnect);
    instance.on('connect_error', handleConnectError);
    instance.io.on('reconnect_attempt', handleReconnectAttempt);
    connectSocket(instance);

    return () => {
      instance.io.off('reconnect_attempt', handleReconnectAttempt);
      // Every listener is dropped with the socket: a later session must never
      // receive events on a stale instance.
      disconnectSocket(instance);
      setSocket(null);
      setStatus('disconnected');
    };
  }, [token]);

  const value = useMemo(
    () => ({ socket, status, connectionCount }),
    [socket, status, connectionCount]
  );

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export default SocketProvider;
