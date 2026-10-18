import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import EmptyState from './EmptyState.jsx';
import MessageBubble from './MessageBubble.jsx';
import { AlertIcon, ArrowDownIcon, ChatBubbleIcon, RefreshIcon } from './icons.jsx';
import { conversationTitle } from '../utils/conversations.js';
import { receiptDetails, receiptLabel, receiptState } from '../utils/receipts.js';
import { formatDayLabel } from '../utils/time.js';

const BOTTOM_THRESHOLD_PX = 120;
const TOP_THRESHOLD_PX = 120;
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** Inserts date separators and marks bubbles that continue a bubble group. */
function buildTimeline(messages) {
  const items = [];
  let lastDayKey = null;
  let lastSender = null;
  let lastTimestamp = 0;

  for (const message of messages) {
    const date = new Date(message.createdAt ?? 0);
    const valid = !Number.isNaN(date.getTime());
    const dayKey = valid ? date.toDateString() : 'unknown';

    if (dayKey !== lastDayKey) {
      items.push({ kind: 'day', key: `day-${dayKey}`, date: message.createdAt });
      lastDayKey = dayKey;
      lastSender = null;
      lastTimestamp = 0;
    }

    // System activity lines ("Alex added Sam") stand alone: never grouped,
    // and they break the bubble group around them.
    const isSystem = message.type === 'system';
    const timestamp = valid ? date.getTime() : 0;
    const grouped =
      !isSystem && lastSender === message.sender && timestamp - lastTimestamp <= GROUP_WINDOW_MS;

    items.push({ kind: 'message', key: message.clientId ?? message.id, message, grouped });
    lastSender = isSystem ? null : message.sender;
    lastTimestamp = timestamp;
  }

  return items;
}

/**
 * Scrollable message list:
 *   - infinite scroll upwards (older pages are prepended without losing the
 *     scroll position)
 *   - auto-scroll to the bottom for own messages / when already near the
 *     bottom, otherwise a "N new messages" button
 *   - date separators + bubble grouping
 *   - reports whether the newest message is in view (`onBottomChange`), which
 *     the chat context uses to decide when a conversation counts as read
 */
export default function MessageList({
  conversation,
  messages,
  history,
  currentUserId,
  onLoadOlder,
  onReloadHistory,
  onRetryMessage,
  onRequestDelete,
  onShowInfo,
  onBottomChange,
}) {
  const scrollRef = useRef(null);
  const prevMessagesRef = useRef([]);
  const prevConversationRef = useRef(null);
  const prependRef = useRef(false);
  const prevHeightRef = useRef(0);
  const atBottomRef = useRef(true);
  const reportedAtBottomRef = useRef(null); // null → report the first position
  const [newCount, setNewCount] = useState(0);

  const timeline = useMemo(() => buildTimeline(messages), [messages]);
  const title = conversationTitle(conversation, currentUserId);

  /** Tells the context when the bottom-anchored state actually changes. */
  const reportAtBottom = useCallback(
    (next) => {
      if (reportedAtBottomRef.current === next) return;
      reportedAtBottomRef.current = next;
      onBottomChange?.(next);
    },
    [onBottomChange]
  );

  const scrollToBottom = useCallback(
    (behavior = 'auto') => {
      const element = scrollRef.current;
      if (!element) return;
      element.scrollTo({ top: element.scrollHeight, behavior });
      atBottomRef.current = true;
      reportAtBottom(true);
      setNewCount(0);
    },
    [reportAtBottom]
  );

  function handleScroll() {
    const element = scrollRef.current;
    if (!element) return;

    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    atBottomRef.current = distanceFromBottom <= BOTTOM_THRESHOLD_PX;
    reportAtBottom(atBottomRef.current);

    if (atBottomRef.current) setNewCount((count) => (count === 0 ? count : 0));

    if (
      element.scrollTop <= TOP_THRESHOLD_PX &&
      history.status === 'ready' &&
      history.hasMore &&
      !history.loadingMore
    ) {
      prependRef.current = true;
      prevHeightRef.current = element.scrollHeight;
      onLoadOlder();
    }
  }

  function handleLoadOlderClick() {
    const element = scrollRef.current;
    if (element) {
      prependRef.current = true;
      prevHeightRef.current = element.scrollHeight;
    }
    onLoadOlder();
  }

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    // Conversation switch (and first mount): jump to the newest message and
    // tell the context the list is bottom-anchored again.
    if (prevConversationRef.current !== conversation.id) {
      prevConversationRef.current = conversation.id;
      prevMessagesRef.current = messages;
      prependRef.current = false;
      atBottomRef.current = true;
      reportAtBottom(true);
      setNewCount(0);
      element.scrollTop = element.scrollHeight;
      return;
    }

    const previous = prevMessagesRef.current;
    prevMessagesRef.current = messages;

    // Older page prepended: keep the reading position stable.
    if (prependRef.current) {
      prependRef.current = false;
      if (prevHeightRef.current > 0) {
        element.scrollTop = element.scrollHeight - prevHeightRef.current;
      }
      return;
    }

    if (messages.length <= previous.length) return;

    const last = messages[messages.length - 1];
    const lastIsMine = last?.sender === currentUserId;

    if (lastIsMine || atBottomRef.current) {
      element.scrollTop = element.scrollHeight;
      return;
    }

    setNewCount((count) => count + (messages.length - previous.length));
  }, [messages, conversation.id, currentUserId, reportAtBottom]);

  const isEmpty = messages.length === 0;

  return (
    <div className="chat-body-wrap">
      <div
        className="chat-body"
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-label={`Message history with ${title}`}
      >
        <div className="chat-body__inner">
          {history.status === 'loading' && isEmpty ? (
            <div className="messages-state" role="status">
              <span className="spinner" aria-hidden="true" />
              <p>Loading messages…</p>
            </div>
          ) : null}

          {history.status === 'error' && isEmpty ? (
            <div className="messages-state messages-state--error" role="alert">
              <AlertIcon size={24} />
              <p>{history.error?.message || 'Could not load this conversation.'}</p>
              <button type="button" className="btn btn--sm" onClick={onReloadHistory}>
                <RefreshIcon size={15} />
                Retry
              </button>
            </div>
          ) : null}

          {history.loadingMore ? (
            <div className="messages-state messages-state--inline" role="status">
              <span className="spinner spinner--sm" aria-hidden="true" />
              <span>Loading older messages…</span>
            </div>
          ) : null}

          {!history.loadingMore && history.status === 'ready' && history.hasMore ? (
            <div className="messages-load-older">
              <button type="button" className="btn btn--ghost btn--sm" onClick={handleLoadOlderClick}>
                <RefreshIcon size={14} />
                Load older messages
              </button>
            </div>
          ) : null}

          {timeline.map((item) => {
            if (item.kind === 'day') {
              return (
                <div className="message-day" key={item.key} role="separator">
                  <span>{formatDayLabel(item.date)}</span>
                </div>
              );
            }

            const { message, grouped } = item;

            if (message.type === 'system') {
              return (
                <div className="message-system" key={item.key} role="note">
                  <span>{message.text ?? 'Group updated'}</span>
                </div>
              );
            }

            const isOwn = message.sender === currentUserId;
            const sender = (conversation.members ?? []).find(
              (member) => member.id === message.sender
            );
            const senderName = isOwn ? 'You' : sender?.displayName || 'Unknown user';

            // Ticks + "Seen by …" only exist for own, stored messages.
            let receipt = null;
            let label = '';
            if (isOwn && message.id && !message.deleted) {
              receipt = receiptState(message, conversation, currentUserId);
              label = receiptLabel(receipt, receiptDetails(message, conversation, currentUserId));
            }

            return (
              <MessageBubble
                key={item.key}
                message={message}
                conversation={conversation}
                currentUserId={currentUserId}
                isOwn={isOwn}
                grouped={grouped}
                showAvatar={!isOwn && !grouped}
                showSenderName={conversation.type === 'group' && !isOwn && !grouped}
                senderUser={sender}
                senderName={senderName}
                senderColor={sender?.avatarColor}
                receipt={receipt}
                receiptLabel={label}
                onShowInfo={onShowInfo}
                onRetry={(target) => onRetryMessage(target.clientId)}
                onRequestDelete={onRequestDelete}
              />
            );
          })}

          {isEmpty && history.status === 'ready' ? (
            <EmptyState
              icon={<ChatBubbleIcon size={26} />}
              title="No messages yet"
              description={
                conversation.type === 'group'
                  ? 'Send the first message to start the discussion.'
                  : `Say hi to ${title}.`
              }
            />
          ) : null}
        </div>
      </div>

      {newCount > 0 ? (
        <button type="button" className="new-messages" onClick={() => scrollToBottom('smooth')}>
          <ArrowDownIcon size={14} />
          {newCount === 1 ? '1 new message' : `${newCount} new messages`}
        </button>
      ) : null}
    </div>
  );
}
