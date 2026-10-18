// ============================================================================
// Canonical UI message shape.
//
// Every server message — a history page row, a socket "message:new" payload, a
// send acknowledgement or the conversation's `lastMessage` preview — is turned
// into the UI shape here, so the whole app agrees on ONE field set:
//
//   { id, clientId, conversationId, sender, type, deleted, encrypted,
//     keyVersion, ciphertext, iv, text, createdAt, status, error,
//     deliveredTo, readBy }
//
// `text` is only filled in for plain rows (system activity lines and legacy
// messages). Encrypted rows keep text:null AND their envelope (`ciphertext`,
// `iv`), because the display layer (useDecryptedText → decryptForConversation)
// decrypts from those two fields. Dropping the envelope here would make every
// received message render "Unable to decrypt this message".
// ============================================================================

/**
 * Server message (REST row / socket payload / ack message) → UI message.
 * Encrypted payloads keep `ciphertext` + `iv`; the display layer decrypts them
 * through useDecryptedText (never the context — one decrypt per envelope,
 * cached in the crypto module).
 */
export function fromServerMessage(message) {
  const deleted = message.deletedForEveryone === true;
  const encrypted = message.encrypted !== false;
  return {
    id: message.id,
    clientId: message.clientId ?? null,
    conversationId: message.conversationId,
    sender: message.sender,
    // 'system' = a plain-text group activity line ("Alex added Sam").
    type: message.type === 'system' ? 'system' : 'user',
    deleted,
    encrypted,
    keyVersion: message.keyVersion ?? 1,
    // The encrypted envelope — decryptForConversation() decrypts these two.
    ciphertext: deleted ? null : message.ciphertext ?? null,
    iv: deleted ? null : message.iv ?? null,
    text: deleted || encrypted ? null : message.ciphertext ?? null,
    createdAt: message.createdAt,
    status: 'sent',
    error: null,
    // Receipts drive the tick icons and the message-info view.
    deliveredTo: message.deliveredTo ?? [],
    readBy: message.readBy ?? [],
  };
}

export default fromServerMessage;
