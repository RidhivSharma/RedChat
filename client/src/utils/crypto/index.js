// ============================================================================
// ChatWave crypto module — single entry point.
//
// Everything end-to-end encryption related lives here and ONLY here (no crypto
// libraries — the browser Web Crypto API `crypto.subtle` is the sole runtime).
//
//   base64.js             bytes <-> base64/UTF-8 helpers
//   jwk.js                JWK parsing + the canonical key form
//   keys.js               ECDH P-256 identity keys (generate/import/export)
//   password.js           PBKDF2 password-wrapped private key backup
//   keyStore.js           non-extractable CryptoKey in IndexedDB
//   sharedKey.js          ECDH deriveKey → AES-GCM-256 (direct chats)
//   messageCrypto.js      AES-GCM encrypt/decrypt of message payloads
//   groupCrypto.js        group keys + per-member wrapping
//   fingerprint.js        SHA-256 key fingerprints ("Verify encryption")
//   conversationCrypto.js caches + the chat layer's encrypt/decrypt helpers
// ============================================================================

export * from './base64.js';
export * from './jwk.js';
export * from './keys.js';
export * from './password.js';
export * from './keyStore.js';
export * from './sharedKey.js';
export * from './messageCrypto.js';
export * from './groupCrypto.js';
export * from './fingerprint.js';
export * from './conversationCrypto.js';
