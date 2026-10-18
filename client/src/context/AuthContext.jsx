import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  authApi,
  clearToken,
  getToken,
  setToken,
  UNAUTHORIZED_EVENT,
  usersApi,
} from '../services/api.js';
import {
  canonicalPublicKey,
  clearCryptoCaches,
  clearStoredPrivateKey,
  decryptPrivateKeyWithPassword,
  encryptPrivateKeyWithPassword,
  exportPrivateKeyJwk,
  exportPublicKey,
  generateKeyPair,
  importPrivateKey,
  loadStoredPrivateKey,
  saveStoredPrivateKey,
} from '../utils/crypto/index.js';

export const AuthContext = createContext(null);

/**
 * Decrypts the password backup and checks that the key inside really is the
 * private half of the public key the server publishes for this account.
 * Throws on a wrong password or a mismatching backup.
 */
async function restoreKeyFromBackup(account, backup, password) {
  const privateJwk = await decryptPrivateKeyWithPassword(backup, password);

  if (
    account.publicKey &&
    canonicalPublicKey(privateJwk) !== canonicalPublicKey(account.publicKey)
  ) {
    throw new Error('The key backup does not match the public key of this account.');
  }

  return importPrivateKey(privateJwk);
}

/**
 * Where the browser-side identity key stands:
 *   idle        — signed out
 *   loading     — session/key resolution in flight
 *   ready       — the non-extractable private key is in memory, E2EE is on
 *   locked      — a session exists but this device has no key: the user must
 *                 re-enter their password (ProtectedRoute shows UnlockScreen)
 *   unavailable — the account has no usable keys (created before encryption
 *                 existed and no password is at hand): the app works but
 *                 sending is disabled — never fall back to plain text
 */
const KEY_IDLE = 'idle';
const KEY_LOADING = 'loading';
const KEY_READY = 'ready';
const KEY_LOCKED = 'locked';
const KEY_UNAVAILABLE = 'unavailable';

/**
 * Session + encryption-key lifecycle.
 *
 * The server never sees the private key: the registration flow generates the
 * ECDH key pair in the browser and uploads only the public key plus a
 * PBKDF2/AES-GCM password-wrapped backup. The working private key is a
 * NON-EXTRACTABLE CryptoKey in IndexedDB (utils/crypto/keyStore.js):
 *   - login     → restore from IndexedDB, else decrypt the server backup with
 *                 the just-typed password and save it locally,
 *   - refresh   → restore from IndexedDB (no password prompt),
 *   - logout    → wipe the stored key and every in-memory crypto cache.
 */
export function AuthProvider({ children }) {
  const [token, setTokenState] = useState(() => getToken());
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(() => Boolean(getToken()));
  const [privateKey, setPrivateKey] = useState(null);
  const [keyStatus, setKeyStatus] = useState(KEY_IDLE);

  // The wrapped backup of the signed-in account (never the key itself).
  const backupRef = useRef(null);
  const privateKeyRef = useRef(null);
  const userRef = useRef(null);

  privateKeyRef.current = privateKey;
  userRef.current = user;

  const applyPrivateKey = useCallback(async (cryptoKey, userId, publicKey) => {
    privateKeyRef.current = cryptoKey;
    setPrivateKey(cryptoKey);
    setKeyStatus(KEY_READY);
    // The record is bound to the account's public key (see keyStore.js).
    if (userId) await saveStoredPrivateKey(userId, cryptoKey, publicKey);
  }, []);

  /**
   * Resolves the key state for an authenticated account without a password:
   * a stored key means "ready"; a missing key with a keyed account means
   * "locked" (UnlockScreen asks for the password); a keyless account means
   * "unavailable" (sending stays disabled).
   */
  const resolveKeys = useCallback(
    async (account) => {
      if (!account?.publicKey) {
        privateKeyRef.current = null;
        setPrivateKey(null);
        setKeyStatus(KEY_UNAVAILABLE);
        return;
      }

      const stored = await loadStoredPrivateKey(account.id, account.publicKey);
      if (stored) {
        privateKeyRef.current = stored;
        setPrivateKey(stored);
        setKeyStatus(KEY_READY);
        return;
      }

      privateKeyRef.current = null;
      setPrivateKey(null);
      setKeyStatus(KEY_LOCKED);
    },
    []
  );

  // Restore the session on refresh: token comes from localStorage, the user
  // (and their encrypted key backup) through GET /api/auth/me. The private key
  // itself is recovered from IndexedDB — no password prompt on a refresh.
  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      setKeyStatus(KEY_IDLE);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    setKeyStatus(KEY_LOADING);

    authApi
      .me()
      .then(async (data) => {
        if (cancelled) return;
        backupRef.current = data.encryptedPrivateKey ?? null;
        setUser(data.user);
        await resolveKeys(data.user);
      })
      .catch(() => {
        if (!cancelled) {
          clearToken();
          setTokenState(null);
          setUser(null);
          setKeyStatus(KEY_IDLE);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [resolveKeys]);

  // The API layer clears the session on a 401 — mirror that in React state and
  // drop the in-memory key/caches. The IndexedDB record stays: logging back in
  // restores the same key without re-deriving it from the password.
  useEffect(() => {
    function handleSessionExpired() {
      setTokenState(null);
      setUser(null);
      privateKeyRef.current = null;
      setPrivateKey(null);
      setKeyStatus(KEY_IDLE);
      clearCryptoCaches();
    }
    window.addEventListener(UNAUTHORIZED_EVENT, handleSessionExpired);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handleSessionExpired);
  }, []);

  /**
   * Equips an account created before encryption existed (no publicKey): while
   * the plain password is still in hand at login, generate a key pair, upload
   * the public key + password-wrapped backup once, and store the working key.
   */
  const equipLegacyAccount = useCallback(async (account, password) => {
    const pair = await generateKeyPair();
    const publicKey = await exportPublicKey(pair.publicKey);
    const privateJwk = await exportPrivateKeyJwk(pair.privateKey);
    const encryptedPrivateKey = await encryptPrivateKeyWithPassword(privateJwk, password);

    const updated = await usersApi.updateMe({ publicKey, encryptedPrivateKey });
    backupRef.current = encryptedPrivateKey;

    const workingKey = await importPrivateKey(privateJwk);
    await applyPrivateKey(workingKey, account.id, publicKey);
    return updated?.user ?? { ...account, publicKey };
  }, [applyPrivateKey]);

  const login = useCallback(
    async (credentials) => {
      const data = await authApi.login(credentials);
      setToken(data.token);
      setTokenState(data.token);
      backupRef.current = data.encryptedPrivateKey ?? null;
      setUser(data.user);
      setKeyStatus(KEY_LOADING);

      let account = data.user;

      if (!account.publicKey) {
        // Legacy account: create and publish its keys now.
        try {
          account = await equipLegacyAccount(account, credentials.password);
        } catch {
          privateKeyRef.current = null;
          setPrivateKey(null);
          setKeyStatus(KEY_UNAVAILABLE);
        }
      } else {
        // Same device: the non-extractable key is already stored (and only
        // trusted when it is bound to this account's published public key).
        const stored = await loadStoredPrivateKey(account.id, account.publicKey);
        if (stored) {
          await applyPrivateKey(stored, account.id, account.publicKey);
        } else if (data.encryptedPrivateKey) {
          // New device / cleared or stale storage: unlock the server backup
          // with the password that was just verified.
          try {
            const restored = await restoreKeyFromBackup(
              account,
              data.encryptedPrivateKey,
              credentials.password
            );
            await applyPrivateKey(restored, account.id, account.publicKey);
          } catch {
            // Backup does not open with this password (e.g. password changed
            // elsewhere): stay locked rather than pretend encryption works.
            privateKeyRef.current = null;
            setPrivateKey(null);
            setKeyStatus(KEY_LOCKED);
          }
        } else {
          privateKeyRef.current = null;
          setPrivateKey(null);
          setKeyStatus(KEY_LOCKED);
        }
      }

      // A legacy account just received its public key: the in-memory user
      // must carry it, otherwise chats would treat this account as keyless.
      setUser(account);
      return { ...data, user: account };
    },
    [applyPrivateKey, equipLegacyAccount]
  );

  const register = useCallback(
    async (payload) => {
      // Generate the identity key pair BEFORE the account exists: the server
      // stores the public key and the password-wrapped backup only.
      const pair = await generateKeyPair();
      const publicKey = await exportPublicKey(pair.publicKey);
      const privateJwk = await exportPrivateKeyJwk(pair.privateKey);
      const encryptedPrivateKey = await encryptPrivateKeyWithPassword(privateJwk, payload.password);

      const data = await authApi.register({ ...payload, publicKey, encryptedPrivateKey });
      setToken(data.token);
      setTokenState(data.token);
      backupRef.current = encryptedPrivateKey;
      setUser(data.user);

      // Working copy: non-extractable in memory + IndexedDB.
      await applyPrivateKey(await importPrivateKey(privateJwk), data.user.id, publicKey);
      return data;
    },
    [applyPrivateKey]
  );

  /**
   * Unlocks the account on a device without the stored key: decrypts the
   * server-side backup with the account password. Throws a friendly error on a
   * wrong password (AES-GCM authentication fails) — UnlockScreen shows it.
   */
  const unlockWithPassword = useCallback(
    async (password) => {
      const account = userRef.current;
      const backup = backupRef.current;
      if (!account?.id) {
        throw new Error('You are not signed in.');
      }
      if (!backup?.ciphertext) {
        throw new Error('This account has no key backup on the server.');
      }

      let restored;
      try {
        restored = await restoreKeyFromBackup(account, backup, password);
      } catch {
        throw new Error('That password does not match your encrypted key backup.');
      }

      await applyPrivateKey(restored, account.id, account.publicKey);
    },
    [applyPrivateKey]
  );

  const logout = useCallback(() => {
    clearToken();
    setTokenState(null);
    setUser(null);
    backupRef.current = null;
    privateKeyRef.current = null;
    setPrivateKey(null);
    setKeyStatus(KEY_IDLE);
    // Keys never outlive the session on a shared device.
    clearCryptoCaches();
    clearStoredPrivateKey().catch(() => {});
  }, []);

  const value = useMemo(
    () => ({
      user,
      token,
      loading,
      login,
      register,
      logout,
      privateKey,
      keyStatus,
      unlockWithPassword,
    }),
    [user, token, loading, login, register, logout, privateKey, keyStatus, unlockWithPassword]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export default AuthProvider;
