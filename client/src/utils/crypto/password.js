// ============================================================================
// Password-wrapped private key backup.
//
// The private key must survive a page refresh AND a fresh login on another
// device, but the server must never be able to read it. So the key is
// encrypted with a key derived from the user's password before it is uploaded:
//
//   password ──PBKDF2-SHA256(310000, random 16-byte salt)──▶ AES-GCM-256 key
//   privateJwk ──AES-GCM(random 12-byte IV)──▶ { ciphertext, iv }
//
// The server stores { ciphertext, iv, salt, iterations } as base64 and can do
// nothing with it except give it back to the owner.
//
// Honest limitation (also in README.md): the account password is the only
// secret protecting this blob, so a malicious/compromised server operator can
// run an offline brute-force against weak passwords.
// ============================================================================

import { base64ToBytes, bytesToBase64, bytesToUtf8, randomBytes, utf8ToBytes } from './base64.js';
import { parseJwk } from './jwk.js';

/** OWASP-recommended PBKDF2-HMAC-SHA256 iteration count for password storage. */
export const PBKDF2_ITERATIONS = 310_000;
const PBKDF2_SALT_BYTES = 16;
const AES_GCM_IV_BYTES = 12;

/**
 * Derives the AES-GCM-256 wrapping key from a password with PBKDF2.
 * The derived key is non-extractable: it exists only inside crypto.subtle.
 */
async function derivePasswordKey(password, salt, iterations) {
  const material = await globalThis.crypto.subtle.importKey(
    'raw',
    utf8ToBytes(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return globalThis.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts a private key (JWK object or string) with the user's password.
 * Returns the server-side backup shape — every binary field is base64:
 *   { ciphertext, iv, salt, iterations }
 */
export async function encryptPrivateKeyWithPassword(privateJwk, password) {
  const jwkText = JSON.stringify(parseJwk(privateJwk));
  const salt = randomBytes(PBKDF2_SALT_BYTES);
  const iv = randomBytes(AES_GCM_IV_BYTES);

  const wrappingKey = await derivePasswordKey(password, salt, PBKDF2_ITERATIONS);
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    utf8ToBytes(jwkText)
  );

  return {
    ciphertext: bytesToBase64(ciphertext),
    iv: bytesToBase64(iv),
    salt: bytesToBase64(salt),
    iterations: PBKDF2_ITERATIONS,
  };
}

/**
 * Reverses encryptPrivateKeyWithPassword. Returns the private key as a JWK
 * object. Throws (AES-GCM OperationError) when the password is wrong or the
 * backup was tampered with — callers treat that as "wrong password".
 */
export async function decryptPrivateKeyWithPassword(backup, password) {
  const { ciphertext, iv, salt, iterations } = backup ?? {};
  if (!ciphertext || !iv || !salt || !Number.isInteger(iterations)) {
    throw new TypeError('Invalid private key backup');
  }

  const wrappingKey = await derivePasswordKey(password, base64ToBytes(salt), iterations);
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(iv) },
    wrappingKey,
    base64ToBytes(ciphertext)
  );

  const jwk = JSON.parse(bytesToUtf8(new Uint8Array(plaintext)));
  parseJwk(jwk); // shape check
  return jwk;
}
