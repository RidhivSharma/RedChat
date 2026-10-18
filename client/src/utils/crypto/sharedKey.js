// ============================================================================
// Shared-key derivation (ECDH + HKDF-free AES key agreement).
//
// Direct chats: both members derive the SAME AES-GCM-256 key from
//   (my private key) × (their public key).
// Group keys:    the same mechanism wraps the group's symmetric key for every
//                member individually (groupCrypto.js).
//
// The derived key is non-extractable — it can encrypt/decrypt but never be
// exported back to JavaScript. The raw ECDH secret itself is never used as an
// AES key: crypto.subtle.deriveKey with ECDH → AES-GCM applies the standard
// KDF defined by the Web Crypto spec.
// ============================================================================

import { importPublicKey } from './keys.js';

/**
 * Derives the AES-GCM-256 conversation key from my private key and the other
 * side's public JWK (string or object). Accepts anything crypto.subtle can
 * import as an ECDH P-256 public key.
 */
export function deriveSharedKey(myPrivateKey, theirPublicJwk) {
  return importPublicKey(theirPublicJwk).then((theirPublicKey) =>
    globalThis.crypto.subtle.deriveKey(
      { name: 'ECDH', public: theirPublicKey },
      myPrivateKey,
      { name: 'AES-GCM', length: 256 },
      false, // non-extractable: the derived key never leaves crypto.subtle
      ['encrypt', 'decrypt']
    )
  );
}
