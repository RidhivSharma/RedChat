// ============================================================================
// Base64 / text helpers for the crypto module.
//
// The Web Crypto API works with ArrayBuffers, while everything that crosses
// the wire (or the database) is a base64 string. These tiny helpers are the
// only place that conversion happens — they run in the browser and in Node
// (both expose btoa/atob and TextEncoder/TextDecoder as globals).
// ============================================================================

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** ArrayBuffer | Uint8Array → base64 string. */
export function bytesToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  // Chunked conversion: String.fromCharCode(...bytes) would blow the call
  // stack on multi-kilobyte ciphertexts.
  const CHUNK_SIZE = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK_SIZE));
  }
  return btoa(binary);
}

/** Base64 string → Uint8Array. */
export function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** UTF-8 text → Uint8Array (message plaintext). */
export function utf8ToBytes(text) {
  return textEncoder.encode(String(text));
}

/** Uint8Array → UTF-8 text. */
export function bytesToUtf8(bytes) {
  return textDecoder.decode(bytes);
}

/**
 * Cryptographically random bytes (IVs, salts). Centralised so every caller
 * uses crypto.getRandomValues and never Math.random.
 */
export function randomBytes(length) {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
