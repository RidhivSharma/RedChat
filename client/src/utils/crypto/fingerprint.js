// ============================================================================
// Key fingerprints — the "Verify encryption" check.
//
// The fingerprint of a conversation is the SHA-256 digest of BOTH members'
// public keys, sorted (so both sides compute the identical string) and shown
// as grouped hex. Users compare it out of band (in person, over a call, via a
// trusted channel). If it matches, no server-side key substitution happened.
//
// The canonical key form (key order, only the ECDH coordinates) comes from
// jwk.js so two different browser implementations still produce the same
// fingerprint for the same key.
// ============================================================================

import { utf8ToBytes } from './base64.js';
import { canonicalPublicKey } from './jwk.js';

/** Groups of 4 hex digits — "a1b2 c3d4 …" is easier to read aloud. */
const GROUP_SIZE = 4;

function toHex(bytes) {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** "a1b2c3d4…" → "a1b2 c3d4 …". */
export function groupHex(hex) {
  const groups = [];
  for (let index = 0; index < hex.length; index += GROUP_SIZE) {
    groups.push(hex.slice(index, index + GROUP_SIZE));
  }
  return groups.join(' ');
}

/**
 * Computes the fingerprint for a pair of public keys (JWK strings or
 * objects). Returns grouped hex, e.g. "0f3a 91c2 …".
 */
export async function keyFingerprint(publicKeyA, publicKeyB) {
  const canonical = [canonicalPublicKey(publicKeyA), canonicalPublicKey(publicKeyB)].sort();
  const digest = await globalThis.crypto.subtle.digest('SHA-256', utf8ToBytes(canonical.join('|')));
  return groupHex(toHex(new Uint8Array(digest)));
}

/**
 * Fingerprint of ONE public key (used in the group verification view, where
 * members compare each other's keys pairwise instead of as a pair). The
 * "chatwave-key|" prefix domain-separates it from keyFingerprint() so the two
 * values can never be confused for one another.
 */
export async function fingerprintOf(publicKey) {
  const canonical = canonicalPublicKey(publicKey);
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    utf8ToBytes(`chatwave-key|${canonical}`)
  );
  return groupHex(toHex(new Uint8Array(digest)));
}
