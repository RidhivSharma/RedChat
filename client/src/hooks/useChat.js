import { useContext } from 'react';
import { ChatContext } from '../context/ChatContext.jsx';

/**
 * Conversations, messages per conversation, presence, typing, the active
 * conversation and every chat action (send / retry / delete / history / typing).
 */
export function useChat() {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChat must be used inside <ChatProvider>');
  }
  return context;
}

export default useChat;
