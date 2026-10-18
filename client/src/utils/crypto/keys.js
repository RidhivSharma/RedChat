// ============================================================================
// Identity keys: ECDH P-256 key pairs and JWK import/export.
//
// Every user has one long-lived key pair:
//   - the PUBLIC key is uploaded (JWK string) and shared with everyone,
//   - the PRIVATE key never leaves the device in the clear: at registration it
//     is exported once (extractable), wrapped with the user's password (see
//     password.js) and only the wrapped copy is stored on the server. From
//     then on the device keeps a NON-EXTRACTABLE CryptoKey (keyStore.js) so
//     JavaScript can use it without ever being able to read it back out.
// ============================================================================

import { sanitizeJwk } from './jwk.js';

/** Curve and algorithm used everywhere in the app. */
export const ECDH_PARAMS = Object.freeze({ name: 'ECDH', namedCurve: 'P-256' });

/**
 * Generates a fresh ECDH P-256 key pair.
 * The pair is extractable because the private key must be JWK-exported once
 * for the password backup; the non-extractable working copy is created via
 * importPrivateKey() afterwards.
 */
export function generateKeyPair() {
  return globalThis.crypto.subtle.generateKey(ECDH_PARAMS, true, ['deriveKey', 'deriveBits']);
}

/** Exports a public CryptoKey as a JWK string (the server wire format). */
export async function exportPublicKey(publicKey) {
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', publicKey);
  return JSON.stringify(sanitizeJwk(jwk));
}

/** Exports a private CryptoKey as a JWK object (password backup input). */
export async function exportPrivateKeyJwk(privateKey) {
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', privateKey);
  return sanitizeJwk(jwk);
}

/**
 * Imports a JWK (string or object) as a public ECDH key.
 * Used for every "the other side" key: chat partners and group key wrappers.
 * Usages are empty on purpose — the Web Crypto spec assigns no operations to
 * ECDH public keys; they are only inputs to deriveKey()/deriveBits().
 */
export function importPublicKey(jwk) {
  return globalThis.crypto.subtle.importKey('jwk', sanitizeJwk(jwk), ECDH_PARAMS, false, []);
}

/**
 * Imports a JWK (string or object) as a NON-EXTRACTABLE private ECDH key.
 * This is the shape kept in IndexedDB: usable for deriveKey, impossible to
 * export back to JavaScript.
 */
export function importPrivateKey(jwk) {
  return globalThis.crypto.subtle.importKey('jwk', sanitizeJwk(jwk), ECDH_PARAMS, false, [
    'deriveKey',
  ]);
}
