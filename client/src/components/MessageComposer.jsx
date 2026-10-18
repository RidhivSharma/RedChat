import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LockIcon, SendIcon } from './icons.jsx';

/** UI limit; the server accepts up to 8000 characters (encryption phase). */
export const MAX_MESSAGE_LENGTH = 2000;

const TEXTAREA_MAX_HEIGHT = 168;

/**
 * Composer: auto-growing textarea, Enter sends, Shift+Enter inserts a line
 * break, with a live character counter and inline validation.
 *
 * `disabled` gates the whole composer while the private key is unavailable —
 * there is no plain-text fallback, so sending must not be possible at all.
 */
export default function MessageComposer({
  onSend,
  onTyping,
  onStopTyping,
  disabled = false,
  disabledReason = 'Unlock your encryption key to send messages.',
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const textareaRef = useRef(null);
  // Mirrors `value` for the submit path: a second Enter (key repeat) or a
  // double click must find an already-cleared composer instead of re-sending
  // the same text with a fresh clientId.
  const valueRef = useRef('');
  const justSentRef = useRef(false);

  const tooLong = value.length > MAX_MESSAGE_LENGTH;
  const ratio = value.length / MAX_MESSAGE_LENGTH;

  // Auto-grow up to a maximum height, then scroll internally.
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
    element.style.overflowY = element.scrollHeight > TEXTAREA_MAX_HEIGHT ? 'auto' : 'hidden';
  }, [value]);

  // Leaving the conversation (or unmounting) stops the typing indicator.
  useEffect(() => () => onStopTyping?.(), [onStopTyping]);

  function handleChange(event) {
    const next = event.target.value;
    valueRef.current = next;
    justSentRef.current = false;
    setValue(next);
    if (error && next.trim()) setError('');

    if (next.trim()) onTyping?.();
    else onStopTyping?.();
  }

  function submit() {
    const text = valueRef.current.trim();

    if (!text) {
      // Pressing Enter on an empty composer right after a send is not a
      // mistake worth an error message — just keep the caret in the box.
      if (!justSentRef.current) setError('Type a message before sending.');
      textareaRef.current?.focus();
      return;
    }
    if (tooLong) {
      setError(`Messages can be at most ${MAX_MESSAGE_LENGTH} characters.`);
      return;
    }

    valueRef.current = '';
    justSentRef.current = true;
    setValue('');
    setError('');
    onStopTyping?.();
    onSend(text);
    requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (element) {
        element.focus();
        element.style.height = 'auto';
      }
    });
  }

  function handleKeyDown(event) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent?.isComposing) return;
    event.preventDefault();
    submit();
  }

  const counterClass =
    ratio > 1
      ? 'composer__counter composer__counter--over'
      : ratio >= 0.9
        ? 'composer__counter composer__counter--warn'
        : 'composer__counter';

  if (disabled) {
    return (
      <div className="chat-composer chat-composer--locked" role="status">
        <div className="composer-locked">
          <LockIcon size={16} />
          <span>{disabledReason}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-composer">
      {error ? (
        <p className="field__error composer__error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="composer-box">
        <label className="visually-hidden" htmlFor="message-input">
          Write a message
        </label>
        <textarea
          id="message-input"
          ref={textareaRef}
          className="composer__textarea"
          rows={1}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Write a message…"
          aria-invalid={tooLong || Boolean(error)}
          aria-describedby="composer-hint"
        />
        <button
          type="button"
          className="btn btn--primary btn--icon"
          onClick={submit}
          disabled={!value.trim() || tooLong}
          title="Send message (Enter)"
          aria-label="Send message"
        >
          <SendIcon size={18} />
        </button>
      </div>

      <div className="composer__footer" id="composer-hint">
        <span className="composer__hint">Enter to send · Shift+Enter for a new line</span>
        <span className={counterClass}>
          {value.length}/{MAX_MESSAGE_LENGTH}
        </span>
      </div>
    </div>
  );
}
