import { useContext } from 'react';
import { SocketContext } from '../context/SocketContext.jsx';

/**
 * { socket, status, connectionCount }
 * status: "connecting" | "connected" | "disconnected"
 */
export function useSocket() {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used inside <SocketProvider>');
  }
  return context;
}

export default useSocket;
