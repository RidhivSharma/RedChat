import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ChatWindow from '../components/ChatWindow.jsx';
import ConnectionBanner from '../components/ConnectionBanner.jsx';
import Sidebar from '../components/Sidebar.jsx';
import { useAuth } from '../hooks/useAuth.js';
import { useChat } from '../hooks/useChat.js';
import { usePageTitle } from '../hooks/usePageTitle.js';
import { useSocket } from '../hooks/useSocket.js';
import { useToast } from '../hooks/useToast.js';
import { conversationTitle } from '../utils/conversations.js';

/**
 * The chat screen: sidebar + conversation panel. Below 768px the CSS shows
 * exactly one pane — `data-view` switches between the list and the open chat.
 */
export default function ChatPage() {
  const { user, logout } = useAuth();
  const { status } = useSocket();
  const { activeConversation, selectConversation, closeConversation } = useChat();
  const { showToast } = useToast();
  const navigate = useNavigate();

  usePageTitle(activeConversation ? conversationTitle(activeConversation, user?.id) : 'Chats');

  const [mobileView, setMobileView] = useState('list');

  function handleSelectConversation(conversationId) {
    if (conversationId !== activeConversation?.id) {
      selectConversation(conversationId);
    }
    setMobileView('chat');
  }

  // Mobile back button: show the list again and leave the conversation, so
  // messages that arrive while the chat pane is hidden count as unread.
  function handleBack() {
    setMobileView('list');
    closeConversation();
  }

  function handleLogout() {
    logout();
    showToast('You have been signed out.', 'info');
    navigate('/login', { replace: true });
  }

  const view = activeConversation && mobileView === 'chat' ? 'chat' : 'list';

  return (
    <div className="chat-shell">
      <ConnectionBanner status={status} />

      <div className="chat-layout" data-view={view}>
        <Sidebar
          user={user}
          onSelectConversation={handleSelectConversation}
          onLogout={handleLogout}
        />

        <ChatWindow
          conversation={activeConversation}
          currentUserId={user?.id}
          userName={user?.displayName}
          onBack={handleBack}
        />
      </div>
    </div>
  );
}