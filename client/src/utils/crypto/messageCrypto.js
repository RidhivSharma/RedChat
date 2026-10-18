// ============================================================================
// Message payload encryption (AES-GCM-256).
//
// Every message gets its own random 12-byte IV — reusing an IV with AES-GCM
// would leak plaintext relationships, so it is generated per call. The
// plaintext is UTF-8 encoded and arrives back as
//   { ciphertext, iv }   (both base64)
// which is exactly the wire shape the API/socket layer expects.
//
// decryptMessage NEVER throws: a missing key, a missing/malformed envelope, a
// foreign key or a tampered ciphertext all produce the same human-readable
// placeholder, so a conversation can never crash from one bad envelope. In a
// dev build the reason is logged once per reason (never keys, ciphertext or
// plaintext) so a "Unable to decrypt" report is diagnosable instead of silent.
// ============================================================================

import { base64ToBytes, bytesToBase64, bytesToUtf8, randomBytes, utf8ToBytes } from './base64.js';

/** Shown when a message cannot be decrypted (wrong key, rotated key, tampering). */
export const DECRYPTION_FAILED_MESSAGE = 'Unable to decrypt this message';

const AES_GCM_IV_BYTES = 12;

/** Why a decryption attempt failed — logged, never user-visible. */
export const DECRYPTION_FAILURE = Object.freeze({
  KEY_MISSING: 'key missing',
  ENVELOPE_MISSING: 'ciphertext or iv missing',
  MALFORMED_BASE64: 'malformed base64',
  WRONG_KEY_OR_TAMPERED: 'wrong key or modified payload',
});

/** One dev warning per reason, so a broken history cannot flood the console. */
const warnedReasons = new Set();

/** True in a Vite dev build; false in production builds and in Node tests. */
function isDevEnvironment() {
  try {
    return import.meta.env?.DEV === true;
  } catch {
    return false;
  }
}

/**
 * Dev-only diagnostic. `reason` must be one of DECRYPTION_FAILURE — never a
 * key, ciphertext, plaintext or other sensitive value.
 */
export function warnDecryptionFailure(reason) {
  if (!isDevEnvironment() || warnedReasons.has(reason)) return;
  warnedReasons.add(reason);
  console.warn(`[crypto] message could not be decrypted (${reason})`);
}

/**
 * Encrypts `plaintext` with an AES-GCM-256 key.
 * Returns { ciphertext, iv } as base64 strings.
 */
export async function encryptMessage(key, plaintext) {
  if (!key) throw new TypeError('encryptMessage requires an AES-GCM key');

  const iv = randomBytes(AES_GCM_IV_BYTES);
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    utf8ToBytes(String(plaintext ?? ''))
  );

  return { ciphertext: bytesToBase64(ciphertext), iv: bytesToBase64(iv) };
}

/**
 * Decrypts { ciphertext, iv } with an AES-GCM-256 key.
 * Returns the plaintext, or DECRYPTION_FAILED_MESSAGE when anything goes
 * wrong (no key, malformed base64, wrong key, modified ciphertext).
 */
export async function decryptMessage(key, { ciphertext, iv } = {}) {
  if (!key) {
    warnDecryptionFailure(DECRYPTION_FAILURE.KEY_MISSING);
    return DECRYPTION_FAILED_MESSAGE;
  }
  if (!ciphertext || !iv) {
    warnDecryptionFailure(DECRYPTION_FAILURE.ENVELOPE_MISSING);
    return DECRYPTION_FAILED_MESSAGE;
  }

  let ivBytes;
  let ciphertextBytes;
  try {
    ivBytes = base64ToBytes(iv);
    ciphertextBytes = base64ToBytes(ciphertext);
  } catch {
    warnDecryptionFailure(DECRYPTION_FAILURE.MALFORMED_BASE64);
    return DECRYPTION_FAILED_MESSAGE;
  }

  try {
    const plaintext = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes },
      key,
      ciphertextBytes
    );
    return bytesToUtf8(new Uint8Array(plaintext));
  } catch {
    // AES-GCM authentication failure: wrong key or modified payload.
    warnDecryptionFailure(DECRYPTION_FAILURE.WRONG_KEY_OR_TAMPERED);
    return DECRYPTION_FAILED_MESSAGE;
  }
}
