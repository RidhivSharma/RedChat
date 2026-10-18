// Shape validation for the E2EE key material clients upload. No cryptography
// happens on the server — these checks only reject payloads that could never
// be a usable ECDH P-256 public key / password backup, so broken clients are
// caught at registration instead of at the first failed decryption.

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_PUBLIC_KEY_LENGTH = 10_000;
const MAX_BACKUP_FIELD_LENGTH = 20_000;

/** True when `value` is a JSON string holding an ECDH P-256 public JWK. */
export function isEcdhPublicKeyJwk(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PUBLIC_KEY_LENGTH) {
    return false;
  }

  try {
    const jwk = JSON.parse(value);
    return (
      jwk !== null &&
      typeof jwk === 'object' &&
      jwk.kty === 'EC' &&
      jwk.crv === 'P-256' &&
      typeof jwk.x === 'string' &&
      jwk.x.length > 0 &&
      typeof jwk.y === 'string' &&
      jwk.y.length > 0
    );
  } catch {
    return false;
  }
}

/** True for a base64 string of a sane length (ciphertext/iv/salt fields). */
export function isBase64(value, { maxLength = MAX_BACKUP_FIELD_LENGTH } = {}) {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= maxLength && BASE64_RE.test(value)
  );
}

export default isEcdhPublicKeyJwk;
