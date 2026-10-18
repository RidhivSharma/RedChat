/**
 * Client-side ids.
 *
 * createClientId() stamps every outgoing message with a per-sender unique id
 * (the server deduplicates on sender + clientId, so retries are safe).
 * crypto.randomUUID() only exists in secure contexts (https / localhost) —
 * the getRandomValues fallback keeps plain-http LAN testing working.
 */
export function createClientId() {
  const cryptoApi = typeof crypto !== 'undefined' ? crypto : null;

  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID();
  }

  if (cryptoApi?.getRandomValues) {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export default createClientId;
