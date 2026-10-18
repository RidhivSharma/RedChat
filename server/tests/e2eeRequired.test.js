// REQUIRE_E2EE=true, end to end through HTTP and Socket.io:
//   - registration requires a well-formed publicKey + encryptedPrivateKey,
//   - the login / me responses return the password-wrapped backup,
//   - plaintext messages are rejected on REST and on sockets (no row stored),
//   - encrypted messages and server-generated system messages still work,
//   - group membership changes keep the key protocol intact.
//
// The zod schemas read env.REQUIRE_E2EE when src/ is first imported, so the
// flag is set first and every src/ module is imported dynamically afterwards
// (node:test runs each test file in its own process).
import './helpers/setup.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

process.env.REQUIRE_E2EE = 'true';

const { default: mongoose } = await import('mongoose');
const { io: createSocket } = await import('socket.io-client');
const { default: app } = await import('../src/app.js');
const { connectDB } = await import('../src/config/db.js');
const { Message } = await import('../src/models/index.js');
const { attachSockets } = await import('../src/sockets/index.js');
const { createRequester, dropTestDatabase, startTestServer, stopTestServer } = await import(
  './helpers/harness.js'
);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let server;
let ioServer;
let baseUrl;
let request;

let alice;
let bob;
let carol;
let dave;
let directId;

const clients = [];

/** A real ECDH P-256 public key, serialized like the browser client does. */
async function makePublicKey() {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveKey',
  ]);
  const { x, y, kty, crv } = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  return JSON.stringify({ kty, crv, x, y });
}

const backup = () => ({
  ciphertext: Buffer.from('not-really-encrypted-but-base64').toString('base64'),
  iv: Buffer.from('123456789012').toString('base64'),
  salt: Buffer.from('1234567890123456').toString('base64'),
  iterations: 310_000,
});

async function registerWithKeys(username) {
  const publicKey = await makePublicKey();
  const encryptedPrivateKey = backup();
  const res = await request('POST', '/api/auth/register', {
    json: { username, displayName: username, password: 'password123', publicKey, encryptedPrivateKey },
  });
  assert.equal(res.status, 201, `registering ${username} failed: ${JSON.stringify(res.body)}`);
  return { id: res.body.user.id, token: res.body.token, publicKey, encryptedPrivateKey };
}

function connect(token) {
  const socket = createSocket(baseUrl, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    auth: { token },
  });
  clients.push(socket);
  return socket;
}

function waitFor(socket, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function emitAck(socket, event, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ack of "${event}"`)),
      timeoutMs
    );
    socket.emit(event, payload, (ack) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

before(async () => {
  await connectDB();
  await dropTestDatabase();

  const started = await startTestServer(app);
  server = started.server;
  baseUrl = started.baseUrl;
  request = createRequester(baseUrl);
  ioServer = attachSockets(server);

  alice = await registerWithKeys('alice_req');
  bob = await registerWithKeys('bob_req');
  carol = await registerWithKeys('carol_req');
  dave = await registerWithKeys('dave_req');

  const direct = await request('POST', '/api/conversations/direct', {
    token: alice.token,
    json: { userId: bob.id },
  });
  assert.equal(direct.status, 201);
  directId = direct.body.conversation.id;
});

after(async () => {
  for (const client of clients) client.disconnect();
  await delay(250);
  ioServer?.close();
  await stopTestServer(server);

  if (mongoose.connection.readyState !== 0) {
    await dropTestDatabase();
    await mongoose.disconnect();
  }
});

// ---------------------------------------------------------------------------
// registration / login
// ---------------------------------------------------------------------------

test('register: publicKey and encryptedPrivateKey are required', async () => {
  const base = { username: 'nokeys_req', displayName: 'No Keys', password: 'password123' };

  const none = await request('POST', '/api/auth/register', { json: base });
  assert.equal(none.status, 400);
  assert.equal(none.body.error.code, 'VALIDATION_ERROR');

  const onlyPublic = await request('POST', '/api/auth/register', {
    json: { ...base, publicKey: await makePublicKey() },
  });
  assert.equal(onlyPublic.status, 400);

  const onlyBackup = await request('POST', '/api/auth/register', {
    json: { ...base, encryptedPrivateKey: backup() },
  });
  assert.equal(onlyBackup.status, 400);
});

test('register: the key material shape is validated', async () => {
  const base = {
    username: 'badkeys_req',
    displayName: 'Bad Keys',
    password: 'password123',
  };
  const publicKey = await makePublicKey();

  const rsaKey = await request('POST', '/api/auth/register', {
    json: {
      ...base,
      publicKey: JSON.stringify({ kty: 'RSA', n: 'abc', e: 'AQAB' }),
      encryptedPrivateKey: backup(),
    },
  });
  assert.equal(rsaKey.status, 400, 'only ECDH P-256 public keys are accepted');

  const notJson = await request('POST', '/api/auth/register', {
    json: { ...base, publicKey: 'definitely not a jwk', encryptedPrivateKey: backup() },
  });
  assert.equal(notJson.status, 400);

  const weakIterations = await request('POST', '/api/auth/register', {
    json: { ...base, publicKey, encryptedPrivateKey: { ...backup(), iterations: 10 } },
  });
  assert.equal(weakIterations.status, 400, 'a trivially weak PBKDF2 count is rejected');

  const notBase64 = await request('POST', '/api/auth/register', {
    json: { ...base, publicKey, encryptedPrivateKey: { ...backup(), ciphertext: '***' } },
  });
  assert.equal(notBase64.status, 400);

  const missingSalt = await request('POST', '/api/auth/register', {
    json: {
      ...base,
      publicKey,
      encryptedPrivateKey: { ciphertext: backup().ciphertext, iv: backup().iv, iterations: 310_000 },
    },
  });
  assert.equal(missingSalt.status, 400);
});

test('register/login/me: the backup is stored and only returned to its owner', async () => {
  assert.equal(alice.publicKey.includes('"kty":"EC"'), true);

  const login = await request('POST', '/api/auth/login', {
    json: { username: 'alice_req', password: 'password123' },
  });
  assert.equal(login.status, 200);
  assert.deepEqual(login.body.encryptedPrivateKey, alice.encryptedPrivateKey);
  assert.equal(login.body.user.publicKey, alice.publicKey);

  const me = await request('GET', '/api/auth/me', { token: alice.token });
  assert.deepEqual(me.body.encryptedPrivateKey, alice.encryptedPrivateKey);

  // Other users see the public key, never the wrapped private key.
  const profile = await request('GET', `/api/users/${alice.id}`, { token: bob.token });
  assert.equal(profile.body.user.publicKey, alice.publicKey);
  assert.ok(!('encryptedPrivateKey' in profile.body.user));

  const conversation = await request('GET', `/api/conversations/${directId}`, {
    token: bob.token,
  });
  const aliceMember = conversation.body.conversation.members.find((m) => m.id === alice.id);
  assert.equal(aliceMember.publicKey, alice.publicKey);
  assert.ok(!('encryptedPrivateKey' in aliceMember));
});

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

test('REST: plaintext messages are rejected, encrypted ones are stored', async () => {
  const plain = await request('POST', `/api/conversations/${directId}/messages`, {
    token: alice.token,
    json: { ciphertext: 'hello in the clear', iv: '', encrypted: false, clientId: 'req-rest-plain' },
  });
  assert.equal(plain.status, 400);
  assert.equal(plain.body.error.code, 'ENCRYPTION_REQUIRED');
  assert.equal(await Message.countDocuments({ clientId: 'req-rest-plain' }), 0);

  const encrypted = await request('POST', `/api/conversations/${directId}/messages`, {
    token: alice.token,
    json: {
      ciphertext: 'YWJjZGVmZ2g=',
      iv: 'MTIzNDU2Nzg5MDEy',
      keyVersion: 1,
      encrypted: true,
      clientId: 'req-rest-enc',
    },
  });
  assert.equal(encrypted.status, 201, JSON.stringify(encrypted.body));
  assert.equal(encrypted.body.message.encrypted, true);
});

test('socket: plaintext messages are rejected via the ack, encrypted ones are broadcast', async () => {
  const aliceSocket = connect(alice.token);
  const bobSocket = connect(bob.token);
  await Promise.all([waitFor(aliceSocket, 'connect'), waitFor(bobSocket, 'connect')]);

  const plainAck = await emitAck(aliceSocket, 'message:send', {
    conversationId: directId,
    clientId: 'req-sock-plain',
    ciphertext: 'plain over the socket',
    iv: '',
    encrypted: false,
  });
  assert.equal(plainAck.ok, false);
  assert.equal(plainAck.error.code, 'ENCRYPTION_REQUIRED');
  assert.equal(await Message.countDocuments({ clientId: 'req-sock-plain' }), 0);

  const incoming = waitFor(bobSocket, 'message:new');
  const okAck = await emitAck(aliceSocket, 'message:send', {
    conversationId: directId,
    clientId: 'req-sock-enc',
    ciphertext: 'YWJjZGVmZ2g=',
    iv: 'MTIzNDU2Nzg5MDEy',
    keyVersion: 1,
    encrypted: true,
  });
  assert.equal(okAck.ok, true, JSON.stringify(okAck));

  const { message } = await incoming;
  assert.equal(message.encrypted, true);
  assert.equal(message.ciphertext, 'YWJjZGVmZ2g=');
});

// ---------------------------------------------------------------------------
// group key protocol with the flag on
// ---------------------------------------------------------------------------

function envelope(userId, version, wrappedBy) {
  return { userId, version, wrappedKey: `wrapped-${userId}-${version}`, iv: 'MTIzNDU2Nzg5MDEy', wrappedBy };
}

test('groups: add/rotate keep the key protocol, system messages stay plaintext', async () => {
  const created = await request('POST', '/api/conversations/group', {
    token: alice.token,
    json: {
      name: 'Required Group',
      memberIds: [bob.id, carol.id],
      groupKeys: [alice, bob, carol].map((user) => envelope(user.id, 1, alice.id)),
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const groupId = created.body.conversation.id;
  assert.equal(created.body.conversation.currentKeyVersion, 1);

  // A newcomer without envelopes could never read the group → rejected.
  const noKeys = await request('POST', `/api/conversations/${groupId}/members`, {
    token: alice.token,
    json: { userIds: [dave.id] },
  });
  assert.equal(noKeys.status, 400);
  assert.equal(noKeys.body.error.code, 'INCOMPLETE_KEYS');

  const added = await request('POST', `/api/conversations/${groupId}/members`, {
    token: alice.token,
    json: { userIds: [dave.id], groupKeys: [envelope(dave.id, 1, alice.id)] },
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));

  // The server-generated activity line is exempt from the encryption rule.
  const history = await request('GET', `/api/conversations/${groupId}/messages`, {
    token: dave.token,
  });
  const system = history.body.messages.find((message) => message.type === 'system');
  assert.ok(system, 'expected the "added" system message');
  assert.equal(system.encrypted, false);
  assert.match(system.ciphertext, /added/);

  // Non-admins cannot rotate.
  const forbidden = await request('POST', `/api/conversations/${groupId}/keys`, {
    token: bob.token,
    json: {
      baseVersion: 1,
      groupKeys: [alice, bob, carol, dave].map((user) => envelope(user.id, 2, bob.id)),
    },
  });
  assert.equal(forbidden.status, 403);

  // Carol is removed → an admin rotates to version 2 for the remaining members.
  const removed = await request('DELETE', `/api/conversations/${groupId}/members/${carol.id}`, {
    token: alice.token,
  });
  assert.equal(removed.status, 200);

  const rotated = await request('POST', `/api/conversations/${groupId}/keys`, {
    token: alice.token,
    json: {
      baseVersion: 1,
      groupKeys: [alice, bob, dave].map((user) => envelope(user.id, 2, alice.id)),
    },
  });
  assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
  assert.equal(rotated.body.conversation.currentKeyVersion, 2);

  // Encrypted messages carry the new keyVersion and are accepted.
  const message = await request('POST', `/api/conversations/${groupId}/messages`, {
    token: bob.token,
    json: {
      ciphertext: 'YWJjZGVmZ2g=',
      iv: 'MTIzNDU2Nzg5MDEy',
      keyVersion: 2,
      encrypted: true,
      clientId: 'req-group-v2',
    },
  });
  assert.equal(message.status, 201);
  assert.equal(message.body.message.keyVersion, 2);

  // The remaining members see both versions; the removed member is out.
  const bobView = await request('GET', `/api/conversations/${groupId}`, { token: bob.token });
  assert.deepEqual(
    bobView.body.conversation.groupKeys.map((key) => key.version).sort(),
    [1, 2]
  );
  const carolView = await request('GET', `/api/conversations/${groupId}`, { token: carol.token });
  assert.equal(carolView.status, 403);
});
