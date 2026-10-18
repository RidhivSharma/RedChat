import { WifiOffIcon } from './icons.jsx';

/**
 * Thin banner above the chat layout whenever the socket is not connected.
 * "connecting" covers both the first handshake and automatic reconnects.
 */
export default function ConnectionBanner({ status }) {
  if (status === 'connected') return null;

  const connecting = status === 'connecting';

  return (
    <div
      className={`connection-banner ${
        connecting ? 'connection-banner--connecting' : 'connection-banner--offline'
      }`}
      role="status"
      aria-live="polite"
    >
      {connecting ? (
        <span className="spinner spinner--sm" aria-hidden="true" />
      ) : (
        <WifiOffIcon size={15} />
      )}
      <span>{connecting ? 'Connecting to RedChat…' : 'You are offline — reconnecting…'}</span>
    </div>
  );
}
