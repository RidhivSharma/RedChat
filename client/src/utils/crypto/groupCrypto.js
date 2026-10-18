// ============================================================================
// Group key management.
//
// A group owns one random AES-GCM-256 key per "key version". A version is
// created when the group is created and again every time a member is removed
// (or leaves) — everything a removed member could decrypt is exactly the old
// versions they already received.
//
// The group key itself must be transferable, so it is created EXTRACTABLE and
// wrapped per member with that member's ECDH-derived key:
//
//   groupKey ──AES-GCM──▶ wrapped with deriveKey(myPrivate, memberPublic)
//   { wrappedKey, iv }    + wrappedBy = the member who did the wrapping
//
// Unwrapping uses the same derivation with the wrapper's public key.
// ============================================================================

import { base64ToBytes, bytesToBase64, randomBytes } from './base64.js';
import { deriveSharedKey } from './sharedKey.js';

const AES_GCM_IV_BYTES = 12;

/**
 * Creates a fresh random AES-GCM-256 group key.
 * Extractable on purpose: the owner wraps it for every member (including
 * themselves), and a new version is generated for each rotation.
 */
export function createGroupKey() {
  return globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
}

/** Imports raw key bytes as a non-extractable AES-GCM-256 key (unwrap result). */
export function importGroupKey(rawBytes) {
  return globalThis.crypto.subtle.importKey(
    'raw',
    rawBytes,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Wraps `groupKey` for one member with the ECDH-derived key between
 * `myPrivateKey` and `memberPublicJwk`.
 * Returns { wrappedKey, iv } — both base64, ready for the conversation schema.
 */
export async function wrapGroupKeyForMember(groupKey, myPrivateKey, memberPublicJwk) {
  const rawKey = await globalThis.crypto.subtle.exportKey('raw', groupKey);
  const wrappingKey = await deriveSharedKey(myPrivateKey, memberPublicJwk);

  const iv = randomBytes(AES_GCM_IV_BYTES);
  const wrappedKey = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    rawKey
  );

  return { wrappedKey: bytesToBase64(wrappedKey), iv: bytesToBase64(iv) };
}

/**
 * Unwraps a group key that `wrapperPublicJwk` wrapped for me.
 * `wrapped` is { wrappedKey, iv } (base64). Returns an AES-GCM-256 CryptoKey.
 * Throws when the envelope was wrapped by someone else / is tampered with.
 */
export async function unwrapGroupKey(wrapped, myPrivateKey, wrapperPublicJwk) {
  const wrappingKey = await deriveSharedKey(myPrivateKey, wrapperPublicJwk);

  const rawKey = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(wrapped.iv) },
    wrappingKey,
    base64ToBytes(wrapped.wrappedKey)
  );

  return importGroupKey(rawKey);
}
