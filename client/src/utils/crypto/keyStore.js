// ============================================================================
// IndexedDB key storage.
//
// The decrypted private key lives as a NON-EXTRACTABLE CryptoKey in IndexedDB.
// Structured clone can persist CryptoKeys, and because this one is
// non-extractable even a successful XSS cannot export it back to JavaScript —
// the attacker would have to actively use it inside the page (which is why
// the backup password and CSP still matter).
//
// A page refresh therefore never asks for the password again. Logging out (or
// a session expiry) calls clearStoredPrivateKey(). If the record is gone while
// a session token exists (new device, cleared site data, logout in another
// tab), AuthContext switches to the "locked" state and asks for the password
// to restore the key from the server-side backup.
// ============================================================================

import { canonicalPublicKey } from './jwk.js';

const DB_NAME = 'chatwave-crypto';
const DB_VERSION = 1;
const STORE_NAME = 'privateKeys';
const RECORD_ID = 'identity';

function hasIndexedDb() {
  return typeof indexedDB !== 'undefined';
}

/** Opens (and upgrades on first use) the small key database. */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function runTransaction(mode, operation) {
  return openDatabase().then(
    (database) =>
      new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);
        const request = operation(store);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => database.close();
        transaction.onerror = () => {
          database.close();
          reject(transaction.error);
        };
        transaction.onabort = () => {
          database.close();
          reject(transaction.error);
        };
      })
  );
}

/** Canonical form of a public key, or null when it cannot be parsed. */
function safeCanonical(publicKey) {
  try {
    return publicKey ? canonicalPublicKey(publicKey) : null;
  } catch {
    return null;
  }
}

/**
 * Persists the non-extractable private key for `userId`.
 * The record also remembers WHICH public key the private key belongs to, so a
 * key that no longer matches the account's published key is never trusted
 * (see loadStoredPrivateKey).
 * Storage failures (private window, quota) are swallowed: the key then only
 * lives for the current page session and the unlock screen shows up on the
 * next refresh.
 */
export async function saveStoredPrivateKey(userId, cryptoKey, publicKey) {
  if (!hasIndexedDb()) return false;
  try {
    await runTransaction('readwrite', (store) =>
      store.put({
        id: RECORD_ID,
        userId: String(userId),
        publicKey: safeCanonical(publicKey),
        key: cryptoKey,
        savedAt: Date.now(),
      })
    );
    return true;
  } catch (error) {
    console.warn('[crypto] could not persist the private key:', error?.message ?? error);
    return false;
  }
}

/**
 * Loads the stored private key for `userId`, or null when there is none, it
 * belongs to another account (a different user logged in last), or it does not
 * provably belong to `publicKey` — the key the server publishes for this
 * account. A non-extractable key cannot be inspected, so records written
 * without a public key (older versions) are treated as unverifiable and the
 * caller falls back to restoring the key from the password backup, which
 * always matches the published key.
 */
export async function loadStoredPrivateKey(userId, publicKey) {
  if (!hasIndexedDb() || !userId) return null;
  try {
    const record = await runTransaction('readonly', (store) => store.get(RECORD_ID));
    if (!record || record.userId !== String(userId)) return null;

    const expected = safeCanonical(publicKey);
    if (!expected || record.publicKey !== expected) return null;

    return record.key ?? null;
  } catch (error) {
    console.warn('[crypto] could not read the stored private key:', error?.message ?? error);
    return null;
  }
}

/** Removes the stored key — called on logout and session expiry. */
export async function clearStoredPrivateKey() {
  if (!hasIndexedDb()) return;
  try {
    await runTransaction('readwrite', (store) => store.delete(RECORD_ID));
  } catch (error) {
    console.warn('[crypto] could not clear the stored private key:', error?.message ?? error);
  }
}
