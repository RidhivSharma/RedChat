// ============================================================================
// JWK helpers.
//
// Keys travel as JWK objects (private, inside the password backup) or as JWK
// strings (public key on the server). Both shapes must be accepted everywhere,
// and the "fingerprint" canonical form (fingerprint.js) relies on a single
// deterministic field order, so all parsing goes through this module.
// ============================================================================

/**
 * Accepts a JWK object or a JSON string and returns the object.
 * Malformed input throws a TypeError — callers surface that as a decryption
 * failure / validation error, never as a crash.
 */
export function parseJwk(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string' && value.length > 0) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // fall through to the error below
    }
  }
  throw new TypeError('Not a valid JWK (expected an object or a JSON string)');
}

/**
 * Strips advisory JWK metadata (`key_ops`, `ext`, `use`) so keys are portable
 * between implementations. Node's WebCrypto, for example, exports ECDH public
 * keys with `"key_ops": []` and then refuses to re-import them with any usage
 * unless that field is removed. The remaining fields (kty, crv, x, y, d) are
 * the key material itself.
 */
export function sanitizeJwk(value) {
  const jwk = parseJwk(value);
  const { key_ops: _keyOps, ext: _ext, use: _use, ...material } = jwk;
  return material;
}

/**
 * Deterministic, implementation-independent string for a public key:
 * only the ECDH P-256 coordinates, always in the same order. Two browsers
 * may serialize JWKs with different field orders — the fingerprint must not.
 */
export function canonicalPublicKey(value) {
  const jwk = parseJwk(value);
  return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
}
