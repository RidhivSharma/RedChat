import { useCallback, useEffect, useState } from 'react';
import BrandLogo from './BrandLogo.jsx';
import ChatHeader from './ChatHeader.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';
import EmptyState from './EmptyState.jsx';
import EncryptionInfoDialog from './EncryptionInfoDialog.jsx';
import GroupInfoPanel from './GroupInfoPanel.jsx';
import MessageComposer from './MessageComposer.jsx';
import MessageInfoDialog from './MessageInfoDialog.jsx';
import MessageList from './MessageList.jsx';
import { useChat } from '../hooks/useChat.js';
import { useToast } from '../hooks/useToast.js';

const EMPTY_HISTORY = {
  status: 'loading',
  error: null,
  hasMore: false,
  nextBefore: null,
  loadingMore: false,
};

/**
 * The conversation panel: header (name / avatar / status), the scrollable
 * message list and the composer. Renders a placeholder when nothing is open.
 */
export default function ChatWindow({ conversation, currentUserId, userName, onBack }) {
  const {
    messagesByConversation,
    historyByConversation,
    typingByConversation,
    presence,
    sendMessage,
    retryMessage,
    deleteMessage,
    notifyTyping,
    stopTyping,
    notifyAtBottom,
    loadOlderMessages,
    reloadConversation,
    keyStatus,
  } = useChat();
  const { showToast } = useToast();
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [infoMessage, setInfoMessage] = useState(null);
  const [groupInfoOpen, setGroupInfoOpen] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);

  const activeId = conversation?.id ?? null;
  const encryptionReady = keyStatus === 'ready';

  // A dialog belongs to the conversation it was opened from.
  useEffect(() => {
    setInfoMessage(null);
    setGroupInfoOpen(false);
    setVerifyOpen(false);
  }, [activeId]);

  // Stable per conversation so the composer's cleanup only fires when the
  // conversation actually changes (or the component unmounts).
  const handleSend = useCallback(
    (text) => {
      if (activeId) sendMessage(activeId, text);
    },
    [activeId, sendMessage]
  );
  const handleTyping = useCallback(() => {
    if (activeId) notifyTyping(activeId);
  }, [activeId, notifyTyping]);
  const handleStopTyping = useCallback(() => {
    if (activeId) stopTyping(activeId);
  }, [activeId, stopTyping]);
  const handleLoadOlder = useCallback(() => {
    if (activeId) loadOlderMessages(activeId);
  }, [activeId, loadOlderMessages]);
  const handleReloadHistory = useCallback(() => {
    if (activeId) reloadConversation(activeId);
  }, [activeId, reloadConversation]);
  // The list reports whether the newest message is in view; the chat context
  // uses that (plus tab visibility) to decide when to send message:read.
  const handleBottomChange = useCallback(
    (isAtBottom) => {
      if (activeId) notifyAtBottom(isAtBottom);
    },
    [activeId, notifyAtBottom]
  );

  if (!conversation) {
    return (
      <section className="chat-panel chat-panel--empty" aria-label="Conversation">
        <div className="chat-panel__body">
          <EmptyState
            icon={<BrandLogo size={34} />}
            title={`Hi ${userName ?? 'there'} 👋`}
            description="Pick a conversation on the left, or search for someone to start chatting."
          />
        </div>
      </section>
    );
  }

  const messages = messagesByConversation[conversation.id] ?? [];
  const history = historyByConversation[conversation.id] ?? EMPTY_HISTORY;
  const typingUserIds = Object.keys(typingByConversation[conversation.id] ?? {});

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteMessage(conversation.id, pendingDelete.id);
      showToast('Message deleted for everyone.', 'success');
      setPendingDelete(null);
    } catch (error) {
      showToast(error?.message || 'Could not delete the message.', 'error');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="chat-panel" aria-label="Conversation">
      <ChatHeader
        conversation={conversation}
        currentUserId={currentUserId}
        presence={presence}
        typingUserIds={typingUserIds}
        onBack={onBack}
        onShowGroupInfo={() => setGroupInfoOpen(true)}
        onVerifyEncryption={() => setVerifyOpen(true)}
      />

      <MessageList
        conversation={conversation}
        messages={messages}
        history={history}
        currentUserId={currentUserId}
        onLoadOlder={handleLoadOlder}
        onReloadHistory={handleReloadHistory}
        onRetryMessage={(clientId) => retryMessage(conversation.id, clientId)}
        onRequestDelete={setPendingDelete}
        onShowInfo={setInfoMessage}
        onBottomChange={handleBottomChange}
      />

      <MessageComposer
        onSend={handleSend}
        onTyping={handleTyping}
        onStopTyping={handleStopTyping}
        disabled={!encryptionReady}
        disabledReason={
          keyStatus === 'unavailable'
            ? 'Encryption keys are not available on this device — sending is disabled. Sign out and sign in again to restore them.'
            : 'Unlock your encryption key to send messages.'
        }
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Delete for everyone?"
        description="This message will be removed for every member of the conversation. This cannot be undone."
        confirmLabel="Delete for everyone"
        danger
        busy={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />

      <MessageInfoDialog
        open={Boolean(infoMessage)}
        message={infoMessage}
        conversation={conversation}
        currentUserId={currentUserId}
        onClose={() => setInfoMessage(null)}
      />

      <EncryptionInfoDialog
        open={verifyOpen}
        conversation={conversation}
        currentUserId={currentUserId}
        onClose={() => setVerifyOpen(false)}
      />

      <GroupInfoPanel
        open={groupInfoOpen && conversation.type === 'group'}
        conversation={conversation}
        currentUserId={currentUserId}
        onClose={() => setGroupInfoOpen(false)}
        onLeft={() => setGroupInfoOpen(false)}
      />
    </section>
  );
}