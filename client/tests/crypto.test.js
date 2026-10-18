// ============================================================================
// Client crypto module tests — Node's built-in test runner.
//
// Node exposes the very same Web Crypto API as the browser through
// globalThis.crypto, so these tests exercise the exact code the app ships
// (src/utils/crypto/*). Run with:  npm test   (in /client)
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  base64ToBytes,
  bytesToBase64,
  bytesToUtf8,
  createGroupKey,
  decryptMessage,
  decryptPrivateKeyWithPassword,
  DECRYPTION_FAILED_MESSAGE,
  deriveSharedKey,
  encryptMessage,
  encryptPrivateKeyWithPassword,
  exportPrivateKeyJwk,
  exportPublicKey,
  fingerprintOf,
  generateKeyPair,
  groupHex,
  importPrivateKey,
  keyFingerprint,
  randomBytes,
  unwrapGroupKey,
  utf8ToBytes,
  wrapGroupKeyForMember,
  parseJwk,
  canonicalPublicKey,
  clearCryptoCaches,
  decryptForConversation,
  encryptForConversation,
  rememberMessagePlaintext,
} from '../src/utils/crypto/index.js';
import { fromServerMessage } from '../src/utils/messages.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function createIdentity() {
  const pair = await generateKeyPair();
  return {
    privateKey: pair.privateKey,
    publicJwk: await exportPublicKey(pair.publicKey),
  };
}

// ---------------------------------------------------------------------------
// base64 helpers
// ---------------------------------------------------------------------------

test('base64 helpers round-trip arbitrary bytes and UTF-8 text', () => {
  const bytes = randomBytes(64);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);

  const text = 'héllo 👋 — ünïcode ✓';
  assert.equal(bytesToUtf8(utf8ToBytes(text)), text);
});

// ---------------------------------------------------------------------------
// message encryption
// ---------------------------------------------------------------------------

test('encrypt/decrypt round trip returns the original plaintext', async () => {
  const key = await createGroupKey();
  const plaintext = 'Meet me at the bridge — bring the plans 🕵️';

  const envelope = await encryptMessage(key, plaintext);
  assert.ok(envelope.ciphertext.length > 0);
  assert.ok(envelope.iv.length > 0);
  assert.notEqual(envelope.ciphertext, plaintext, 'the ciphertext must not contain the plaintext');

  assert.equal(await decryptMessage(key, envelope), plaintext);
});

test('every message gets a fresh 12-byte IV and independent ciphertext', async () => {
  const key = await createGroupKey();
  const first = await encryptMessage(key, 'same text');
  const second = await encryptMessage(key, 'same text');

  assert.notEqual(first.iv, second.iv, 'IVs must never repeat');
  assert.equal(base64ToBytes(first.iv).length, 12);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test('decryptMessage with the wrong key returns the placeholder instead of throwing', async () => {
  const [keyA, keyB] = await Promise.all([createGroupKey(), createGroupKey()]);
  const envelope = await encryptMessage(keyA, 'secret');

  assert.equal(await decryptMessage(keyB, envelope), DECRYPTION_FAILED_MESSAGE);
  assert.equal(await decryptMessage(null, envelope), DECRYPTION_FAILED_MESSAGE);
  assert.equal(
    await decryptMessage(keyA, { ciphertext: envelope.ciphertext, iv: envelope.iv.slice(0, 4) }),
    DECRYPTION_FAILED_MESSAGE,
    'a truncated IV/tampered envelope must not throw'
  );
});

// ---------------------------------------------------------------------------
// ECDH key agreement
// ---------------------------------------------------------------------------

test('ECDH: both sides derive the same AES key', async () => {
  const alice = await createIdentity();
  const bob = await createIdentity();

  const aliceKey = await deriveSharedKey(alice.privateKey, bob.publicJwk);
  const bobKey = await deriveSharedKey(bob.privateKey, alice.publicJwk);

  // Alice encrypts, Bob decrypts — and vice versa.
  const envelope = await encryptMessage(aliceKey, 'direct chat hello');
  assert.equal(await decryptMessage(bobKey, envelope), 'direct chat hello');

  const reply = await encryptMessage(bobKey, 'direct chat reply');
  assert.equal(await decryptMessage(aliceKey, reply), 'direct chat reply');
});

test('ECDH: a third party cannot read the conversation', async () => {
  const alice = await createIdentity();
  const bob = await createIdentity();
  const eve = await createIdentity();

  const aliceKey = await deriveSharedKey(alice.privateKey, bob.publicJwk);
  const eveKey = await deriveSharedKey(eve.privateKey, bob.publicJwk);

  const envelope = await encryptMessage(aliceKey, 'for bob only');
  assert.equal(await decryptMessage(eveKey, envelope), DECRYPTION_FAILED_MESSAGE);
});

// ---------------------------------------------------------------------------
// group key wrapping
// ---------------------------------------------------------------------------

test('group key: wrapped for a member, unwrapped by that member only', async () => {
  const admin = await createIdentity();
  const member = await createIdentity();
  const outsider = await createIdentity();

  const groupKey = await createGroupKey();
  const wrapped = await wrapGroupKeyForMember(groupKey, admin.privateKey, member.publicJwk);

  assert.ok(wrapped.wrappedKey.length > 0);
  assert.ok(wrapped.iv.length > 0);

  // The member unwraps with the admin's public key and can read group messages.
  const unwrapped = await unwrapGroupKey(wrapped, member.privateKey, admin.publicJwk);
  const envelope = await encryptMessage(groupKey, 'hello group');
  assert.equal(await decryptMessage(unwrapped, envelope), 'hello group');

  // An outsider with the same envelope cannot unwrap it.
  await assert.rejects(() => unwrapGroupKey(wrapped, outsider.privateKey, admin.publicJwk));

  // The member's unwrapped key matches the original group key both ways.
  const reply = await encryptMessage(unwrapped, 'reply in group');
  assert.equal(await decryptMessage(groupKey, reply), 'reply in group');
});

test('group key: a member can wrap for themselves (registration flow)', async () => {
  const creator = await createIdentity();
  const groupKey = await createGroupKey();

  const wrapped = await wrapGroupKeyForMember(groupKey, creator.privateKey, creator.publicJwk);
  const unwrapped = await unwrapGroupKey(wrapped, creator.privateKey, creator.publicJwk);

  const envelope = await encryptMessage(groupKey, 'note to self');
  assert.equal(await decryptMessage(unwrapped, envelope), 'note to self');
});

// ---------------------------------------------------------------------------
// password backup
// ---------------------------------------------------------------------------

test('password backup round trip restores the exact private JWK', async () => {
  const pair = await generateKeyPair();
  const privateJwk = await exportPrivateKeyJwk(pair.privateKey);

  const backup = await encryptPrivateKeyWithPassword(privateJwk, 'correct horse battery staple');

  assert.equal(base64ToBytes(backup.iv).length, 12, 'random 12-byte IV');
  assert.equal(base64ToBytes(backup.salt).length, 16, 'random 16-byte salt');
  assert.equal(backup.iterations, 310_000);
  assert.ok(backup.ciphertext.length > 0);

  const restored = await decryptPrivateKeyWithPassword(backup, 'correct horse battery staple');
  assert.deepEqual(restored, privateJwk);

  // The restored private key still agrees with the original public key.
  const publicJwk = await exportPublicKey(pair.publicKey);
  const restoredKey = await importPrivateKey(restored);
  const peer = await createIdentity();
  const mine = await deriveSharedKey(restoredKey, peer.publicJwk);
  const theirs = await deriveSharedKey(peer.privateKey, publicJwk);
  const envelope = await encryptMessage(mine, 'restored key works');
  assert.equal(await decryptMessage(theirs, envelope), 'restored key works');
});

test('password backup: a wrong password fails (and never returns a key)', async () => {
  const pair = await generateKeyPair();
  const privateJwk = await exportPrivateKeyJwk(pair.privateKey);
  const backup = await encryptPrivateKeyWithPassword(privateJwk, 'the-right-password');

  await assert.rejects(() => decryptPrivateKeyWithPassword(backup, 'the-wrong-password'));
  await assert.rejects(() => decryptPrivateKeyWithPassword(backup, ''));
});

test('password backup: two backups of the same key differ (fresh salt + iv)', async () => {
  const pair = await generateKeyPair();
  const privateJwk = await exportPrivateKeyJwk(pair.privateKey);

  const first = await encryptPrivateKeyWithPassword(privateJwk, 'pw');
  const second = await encryptPrivateKeyWithPassword(privateJwk, 'pw');

  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

// ---------------------------------------------------------------------------
// fingerprints
// ---------------------------------------------------------------------------

test('fingerprint: both sides compute the same grouped hex (order-independent)', async () => {
  const alice = await createIdentity();
  const bob = await createIdentity();

  const fromAlice = await keyFingerprint(alice.publicJwk, bob.publicJwk);
  const fromBob = await keyFingerprint(bob.publicJwk, alice.publicJwk);

  assert.equal(fromAlice, fromBob);
  // SHA-256 = 32 bytes = 64 hex chars = 16 groups of 4.
  assert.match(fromAlice, /^([0-9a-f]{4} ){15}[0-9a-f]{4}$/);

  const eve = await createIdentity();
  const withEve = await keyFingerprint(alice.publicJwk, eve.publicJwk);
  assert.notEqual(fromAlice, withEve, 'a different key pair must not collide');
});

test('fingerprint: single-key fingerprint is deterministic and differs per key', async () => {
  const alice = await createIdentity();
  const bob = await createIdentity();

  const a1 = await fingerprintOf(alice.publicJwk);
  const a2 = await fingerprintOf(alice.publicJwk);
  assert.equal(a1, a2);
  assert.match(a1, /^([0-9a-f]{4} ){15}[0-9a-f]{4}$/);

  const b = await fingerprintOf(bob.publicJwk);
  assert.notEqual(a1, b, 'a different key must not collide');
});

test('fingerprint: pair fingerprint differs from the single-key one', async () => {
  const alice = await createIdentity();
  const bob = await createIdentity();

  const pair = await keyFingerprint(alice.publicJwk, bob.publicJwk);
  const single = await fingerprintOf(alice.publicJwk);
  assert.notEqual(pair, single, 'domain separation keeps the two values distinct');
});

// ---------------------------------------------------------------------------
// key binding + stale conversation data (the "Unable to decrypt" regression)
// ---------------------------------------------------------------------------

test('a private JWK and its public key share one canonical form (key-binding check)', async () => {
  const pair = await generateKeyPair();
  const privateJwk = await exportPrivateKeyJwk(pair.privateKey);
  const publicJwk = await exportPublicKey(pair.publicKey);
  const other = await createIdentity();

  assert.equal(canonicalPublicKey(privateJwk), canonicalPublicKey(publicJwk));
  assert.notEqual(canonicalPublicKey(privateJwk), canonicalPublicKey(other.publicJwk));
});

test('direct chat: a conversation cached without the partner key recovers once the key arrives', async () => {
  clearCryptoCaches();
  const alice = await createIdentity();
  const bob = await createIdentity();

  const member = (id, publicKey) => ({ id, publicKey });
  // What Alice's client holds when Bob had not published his key yet.
  const stale = { id: 'c1', type: 'direct', members: [member('alice', alice.publicJwk), member('bob', null)] };
  const fresh = { id: 'c1', type: 'direct', members: [member('alice', alice.publicJwk), member('bob', bob.publicJwk)] };

  // Bob's view is complete, so he can encrypt to Alice.
  const bobView = { id: 'c1', type: 'direct', members: [member('alice', alice.publicJwk), member('bob', bob.publicJwk)] };
  const envelope = await encryptForConversation(bobView, bob.privateKey, 'bob', 'are you there?');
  const message = { id: 'm1', encrypted: true, keyVersion: 1, ...envelope };

  // Stale data: no key → placeholder (and sending would be refused, not sent in clear).
  await assert.rejects(() => encryptForConversation(stale, alice.privateKey, 'alice', 'hi'));
  assert.equal(
    await decryptForConversation(stale, alice.privateKey, 'alice', message),
    DECRYPTION_FAILED_MESSAGE
  );

  // After the conversation is refetched the same message decrypts.
  assert.equal(await decryptForConversation(fresh, alice.privateKey, 'alice', message), 'are you there?');
});

// ---------------------------------------------------------------------------
// Two users, end to end through the exact shapes that travel to/from the
// server (register → login → send → receive → history → sidebar preview).
// These tests only use the REAL app functions: crypto/*, the UI message
// normalizer and a JSON round trip for every payload that crosses the wire.
// ---------------------------------------------------------------------------

const PASSWORD = 'correct horse battery staple';

/** JSON round trip — everything the server stores/returns is plain JSON. */
function overTheWire(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * The exact register flow of AuthContext.register: generate the identity pair,
 * upload the public JWK as a STRING plus the password-wrapped private key.
 */
async function registerFlow(id, password) {
  const pair = await generateKeyPair();
  const account = {
    id,
    username: id,
    displayName: id,
    publicKey: await exportPublicKey(pair.publicKey),
  };
  const backup = await encryptPrivateKeyWithPassword(await exportPrivateKeyJwk(pair.privateKey), password);
  return { account, backup };
}

/**
 * The exact login flow: the server returns { user, encryptedPrivateKey } as
 * JSON and the client decrypts the backup with the typed password and imports
 * the working (non-extractable) key — then checks the key binds to the
 * published public key, like AuthContext.restoreKeyFromBackup does.
 */
async function loginFlow(account, backup, password) {
  const response = overTheWire({ user: account, encryptedPrivateKey: backup });
  const privateJwk = await decryptPrivateKeyWithPassword(response.encryptedPrivateKey, password);
  assert.equal(
    canonicalPublicKey(privateJwk),
    canonicalPublicKey(response.user.publicKey),
    'the restored private key must match the published public key'
  );
  return { privateKey: await importPrivateKey(privateJwk), publicKey: response.user.publicKey };
}

/** A direct conversation exactly as GET /api/conversations returns it. */
function directConversationFromServer(id, members) {
  return overTheWire({
    id,
    type: 'direct',
    name: '',
    admins: [],
    currentKeyVersion: 1,
    members: members.map(({ id: memberId, publicKey }) => ({ id: memberId, publicKey })),
  });
}

/** One message row exactly as serializeMessage()/message:new sends it. */
function messageFromServer(id, conversationId, sender, clientId, envelope) {
  return overTheWire({
    id,
    conversationId,
    sender,
    clientId,
    ciphertext: envelope.ciphertext,
    iv: envelope.iv,
    keyVersion: envelope.keyVersion,
    encrypted: true,
    deletedForEveryone: false,
    deliveredTo: [],
    readBy: [],
    createdAt: new Date().toISOString(),
  });
}

test('two-user E2EE pipeline: A sends → the server JSON shape → B decrypts (the real bug)', async () => {
  clearCryptoCaches();
  const alice = await registerFlow('alice-e2e', PASSWORD);
  const bob = await registerFlow('bob-e2e', PASSWORD);

  // A fresh device: only the server-side backup reaches the browser.
  const aliceLogin = await loginFlow(alice.account, alice.backup, PASSWORD);
  const bobLogin = await loginFlow(bob.account, bob.backup, PASSWORD);

  const aliceView = directConversationFromServer('conv-e2e', [alice.account, bob.account]);
  const bobView = directConversationFromServer('conv-e2e', [alice.account, bob.account]);

  // A sends: encryption happens BEFORE the payload leaves the client ...
  const envelope = await encryptForConversation(aliceView, aliceLogin.privateKey, alice.account.id, 'hello bob 🔐');
  // ... the server stores/relays ciphertext + iv + keyVersion ...
  const row = messageFromServer('m1', 'conv-e2e', alice.account.id, 'client-1', overTheWire(envelope));
  // ... and B's client normalizes the server row exactly like history/socket does.
  const uiMessage = fromServerMessage(row);

  assert.equal(
    uiMessage.ciphertext,
    envelope.ciphertext,
    'the UI message must keep the ciphertext envelope'
  );
  assert.equal(uiMessage.iv, envelope.iv, 'the UI message must keep the iv envelope');

  const received = await decryptForConversation(bobView, bobLogin.privateKey, bob.account.id, uiMessage);
  assert.equal(received, 'hello bob 🔐');
});

test('two-user E2EE pipeline: the reverse direction (B → A) decrypts too', async () => {
  clearCryptoCaches();
  const alice = await registerFlow('alice-rev', PASSWORD);
  const bob = await registerFlow('bob-rev', PASSWORD);
  const aliceLogin = await loginFlow(alice.account, alice.backup, PASSWORD);
  const bobLogin = await loginFlow(bob.account, bob.backup, PASSWORD);

  const conversation = directConversationFromServer('conv-rev', [alice.account, bob.account]);

  const envelope = await encryptForConversation(conversation, bobLogin.privateKey, bob.account.id, 'hi alice');
  const uiMessage = fromServerMessage(
    messageFromServer('m2', 'conv-rev', bob.account.id, 'client-2', envelope)
  );

  assert.equal(
    await decryptForConversation(conversation, aliceLogin.privateKey, alice.account.id, uiMessage),
    'hi alice'
  );
});

test('two-user E2EE pipeline: the sender can read their own sent message from the server row', async () => {
  clearCryptoCaches();
  const alice = await registerFlow('alice-own', PASSWORD);
  const bob = await registerFlow('bob-own', PASSWORD);
  const aliceLogin = await loginFlow(alice.account, alice.backup, PASSWORD);
  const bobLogin = await loginFlow(bob.account, bob.backup, PASSWORD);

  const conversation = directConversationFromServer('conv-own', [alice.account, bob.account]);
  const envelope = await encryptForConversation(conversation, aliceLogin.privateKey, alice.account.id, 'my own line');

  // Own sends are remembered under the clientId before the ack, and under the
  // server id when the confirmed message arrives (ChatContext.deliver).
  rememberMessagePlaintext('conv-own', { clientId: 'client-3' }, 'my own line');
  const uiMessage = fromServerMessage(messageFromServer('m3', 'conv-own', alice.account.id, 'client-3', envelope));
  rememberMessagePlaintext('conv-own', uiMessage, 'my own line');

  assert.equal(
    await decryptForConversation(conversation, aliceLogin.privateKey, alice.account.id, uiMessage),
    'my own line'
  );

  // Even without the cache the envelope decrypts with the sender's own key.
  clearCryptoCaches();
  assert.equal(
    await decryptForConversation(conversation, aliceLogin.privateKey, alice.account.id, uiMessage),
    'my own line'
  );
});

test('sidebar preview: the conversation lastMessage envelope decrypts on the client', async () => {
  clearCryptoCaches();
  const alice = await registerFlow('alice-preview', PASSWORD);
  const bob = await registerFlow('bob-preview', PASSWORD);
  const aliceLogin = await loginFlow(alice.account, alice.backup, PASSWORD);

  const conversation = directConversationFromServer('conv-preview', [alice.account, bob.account]);
  const envelope = await encryptForConversation(conversation, aliceLogin.privateKey, alice.account.id, 'last line');
  const row = messageFromServer('m4', 'conv-preview', alice.account.id, 'client-4', envelope);

  // ConversationList builds the preview from conversation.lastMessage through
  // the same normalizer.
  const preview = fromServerMessage(row);
  assert.equal(
    await decryptForConversation(conversation, aliceLogin.privateKey, alice.account.id, preview),
    'last line'
  );
});

test('group E2EE pipeline: versioned keys decrypt old and new messages', async () => {
  clearCryptoCaches();
  const alice = await registerFlow('alice-grp', PASSWORD);
  const bob = await registerFlow('bob-grp', PASSWORD);
  const aliceLogin = await loginFlow(alice.account, alice.backup, PASSWORD);
  const bobLogin = await loginFlow(bob.account, bob.backup, PASSWORD);

  // v1: the creator wraps the group key for every member — including itself.
  const v1 = await createGroupKey();
  const v1ForBob = overTheWire(
    await wrapGroupKeyForMember(v1, aliceLogin.privateKey, bobLogin.publicKey)
  );
  const v1ForAlice = overTheWire(
    await wrapGroupKeyForMember(v1, aliceLogin.privateKey, aliceLogin.publicKey)
  );

  // v2 after a rotation: a brand-new key wrapped for the remaining members.
  const v2 = await createGroupKey();
  const v2ForBob = overTheWire(
    await wrapGroupKeyForMember(v2, aliceLogin.privateKey, bobLogin.publicKey)
  );
  const v2ForAlice = overTheWire(
    await wrapGroupKeyForMember(v2, aliceLogin.privateKey, aliceLogin.publicKey)
  );

  // GET /api/conversations/:id returns only MY group key envelopes.
  const members = [
    { id: alice.account.id, publicKey: alice.account.publicKey },
    { id: bob.account.id, publicKey: bob.account.publicKey },
  ];
  const bobView = overTheWire({
    id: 'conv-grp',
    type: 'group',
    name: 'Crew',
    currentKeyVersion: 2,
    members,
    groupKeys: [
      { userId: bob.account.id, version: 1, ...v1ForBob, wrappedBy: alice.account.id },
      { userId: bob.account.id, version: 2, ...v2ForBob, wrappedBy: alice.account.id },
    ],
  });
  const aliceView = overTheWire({
    id: 'conv-grp',
    type: 'group',
    name: 'Crew',
    currentKeyVersion: 2,
    members,
    groupKeys: [
      { userId: alice.account.id, version: 1, ...v1ForAlice, wrappedBy: alice.account.id },
      { userId: alice.account.id, version: 2, ...v2ForAlice, wrappedBy: alice.account.id },
    ],
  });

  // An old message (keyVersion 1) is created against the v1 snapshot ...
  const v1View = overTheWire({ ...aliceView, currentKeyVersion: 1 });
  const oldEnvelope = await encryptForConversation(
    v1View,
    aliceLogin.privateKey,
    alice.account.id,
    'old v1 line'
  );
  const oldRow = messageFromServer('g1', 'conv-grp', alice.account.id, 'g-client-1', oldEnvelope);

  // ... a new one uses the newest version ...
  const newEnvelope = await encryptForConversation(
    aliceView,
    aliceLogin.privateKey,
    alice.account.id,
    'new v2 line'
  );
  assert.equal(newEnvelope.keyVersion, 2);
  const newRow = messageFromServer('g2', 'conv-grp', alice.account.id, 'g-client-2', newEnvelope);

  // ... and Bob reads both from the same conversation view.
  assert.equal(
    await decryptForConversation(bobView, bobLogin.privateKey, bob.account.id, fromServerMessage(oldRow)),
    'old v1 line'
  );
  assert.equal(
    await decryptForConversation(bobView, bobLogin.privateKey, bob.account.id, fromServerMessage(newRow)),
    'new v2 line'
  );

  // The creator's own envelope unwraps with their own key (self-wrap).
  const selfUnwrapped = await unwrapGroupKey(
    { wrappedKey: v1ForAlice.wrappedKey, iv: v1ForAlice.iv },
    aliceLogin.privateKey,
    aliceLogin.publicKey
  );
  const probe = await encryptMessage(v1, 'creator copy');
  assert.equal(await decryptMessage(selfUnwrapped, probe), 'creator copy');
});
