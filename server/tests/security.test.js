// Security hardening: removed members cannot delete their old messages,
// public payloads never expose private fields, and malformed/oversized
// requests fail with the shared safe error shape.
import './helpers/setup.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import app from '../src/app.js';
import { connectDB } from '../src/config/db.js';
import { Message } from '../src/models/index.js';
import {
  createRequester,
  dropTestDatabase,
  startTestServer,
  stopTestServer,
} from './helpers/harness.js';

const USER_PUBLIC_KEYS = ['avatarColor', 'displayName', 'id', 'lastSeen', 'publicKey', 'username'];

let server;
let baseUrl;
let request;
let alice;
let bob;
let carol;

async function registerUser(username, displayName) {
  const res = await request('POST', '/api/auth/register', {
    json: { username, displayName, password: 'password123' },
  });
  assert.equal(res.status, 201, `registering ${username} failed: ${JSON.stringify(res.body)}`);
  return { id: res.body.user.id, token: res.body.token };
}

before(async () => {
  await connectDB();
  await dropTestDatabase();

  const started = await startTestServer(app);
  server = started.server;
  baseUrl = started.baseUrl;
  request = createRequester(baseUrl);

  alice = await registerUser('alice_sec', 'Alice');
  bob = await registerUser('bob_sec', 'Bob');
  carol = await registerUser('carol_sec', 'Carol');
});

after(async () => {
  await stopTestServer(server);
  if (mongoose.connection.readyState !== 0) {
    await dropTestDatabase();
    await mongoose.connection.close();
  }
});

test('removed member can no longer delete their own old message (REST)', async () => {
  const group = await request('POST', '/api/conversations/group', {
    token: alice.token,
    json: { name: 'Security group', memberIds: [bob.id, carol.id] },
  });
  assert.equal(group.status, 201);
  const groupId = group.body.conversation.id;

  const sent = await request('POST', `/api/conversations/${groupId}/messages`, {
    token: carol.token,
    json: { ciphertext: 'carol-old-message', iv: 'iv-carol', clientId: 'sec-1' },
  });
  assert.equal(sent.status, 201);
  const messageId = sent.body.message.id;

  const removed = await request('DELETE', `/api/conversations/${groupId}/members/${carol.id}`, {
    token: alice.token,
  });
  assert.equal(removed.status, 200);

  // Carol is no longer a member: even her own old message is out of reach.
  const denied = await request('DELETE', `/api/messages/${messageId}`, { token: carol.token });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(denied.body.error.code, 'NOT_A_MEMBER');

  // The message was not touched.
  const raw = await Message.findById(messageId).select('deletedForEveryone ciphertext').lean();
  assert.equal(raw.deletedForEveryone, false);
  assert.equal(raw.ciphertext, 'carol-old-message');
});

test('removal from one group does not affect the member in other conversations', async () => {
  // A direct conversation Alice <-> Carol, created after Carol left the group.
  const direct = await request('POST', '/api/conversations/direct', {
    token: carol.token,
    json: { userId: alice.id },
  });
  assert.ok([200, 201].includes(direct.status));
  const directId = direct.body.conversation.id;

  const sent = await request('POST', `/api/conversations/${directId}/messages`, {
    token: carol.token,
    json: { ciphertext: 'carol-direct', iv: 'iv-direct', clientId: 'sec-2' },
  });
  assert.equal(sent.status, 201);

  const deleted = await request('DELETE', `/api/messages/${sent.body.message.id}`, {
    token: carol.token,
  });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.message.deletedForEveryone, true);
});

test("API responses never include passwordHash or another user's private keys", async () => {
  const direct = await request('POST', '/api/conversations/direct', {
    token: alice.token,
    json: { userId: bob.id },
  });
  const conversationId = direct.body.conversation.id;

  const [conversationRes, listRes, profileRes, searchRes, meRes] = await Promise.all([
    request('GET', `/api/conversations/${conversationId}`, { token: alice.token }),
    request('GET', '/api/conversations', { token: alice.token }),
    request('GET', `/api/users/${bob.id}`, { token: alice.token }),
    request('GET', '/api/users/search?q=bob', { token: alice.token }),
    request('GET', '/api/auth/me', { token: alice.token }),
  ]);

  // Other-user and aggregate responses: public fields only.
  for (const res of [conversationRes, listRes, profileRes, searchRes]) {
    assert.equal(res.status, 200);
    const serialized = JSON.stringify(res.body);
    assert.ok(!serialized.includes('passwordHash'), 'must never leak passwordHash');
    assert.ok(!serialized.includes('encryptedPrivateKey'), 'must never leak encryptedPrivateKey');
  }

  // The account holder's own /auth/me carries their (encrypted) private key
  // material — needed to unlock E2EE after a refresh — but still no hash.
  assert.equal(meRes.status, 200);
  assert.ok('encryptedPrivateKey' in meRes.body);
  assert.ok(!JSON.stringify(meRes.body).includes('passwordHash'));

  // Every embedded member object is the public shape only.
  const conversation = conversationRes.body.conversation;
  assert.ok(conversation.members.length >= 2);
  for (const member of conversation.members) {
    assert.deepEqual(Object.keys(member).sort(), USER_PUBLIC_KEYS);
  }

  // The searcher never sees themselves.
  assert.ok(!searchRes.body.users.some((user) => user.username === 'alice_sec'));
});

test('malformed JSON gets the shared error shape, not parser internals', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-json',
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.deepEqual(body, { error: { message: 'Invalid JSON body', code: 'VALIDATION_ERROR' } });
});

test('oversized request bodies are rejected with 413', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice_sec', password: 'x'.repeat(200_000) }),
  });
  const body = await res.json();

  assert.equal(res.status, 413);
  assert.equal(body.error.code, 'PAYLOAD_TOO_LARGE');
  assert.ok(!JSON.stringify(body).includes('xxxx'), 'no request content in the response');
});

test('group key envelopes are length-limited', async () => {
  const tooLongKey = await request('POST', '/api/conversations/group', {
    token: alice.token,
    json: {
      name: 'Key limits',
      memberIds: [bob.id, carol.id],
      groupKeys: [
        {
          userId: bob.id,
          version: 1,
          wrappedKey: 'x'.repeat(2001),
          iv: 'aXY=',
          wrappedBy: alice.id,
        },
      ],
    },
  });
  assert.equal(tooLongKey.status, 400);
  assert.equal(tooLongKey.body.error.code, 'VALIDATION_ERROR');

  const tooLongIv = await request('POST', '/api/conversations/group', {
    token: alice.token,
    json: {
      name: 'Key limits',
      memberIds: [bob.id, carol.id],
      groupKeys: [
        {
          userId: bob.id,
          version: 1,
          wrappedKey: 'x',
          iv: 'a'.repeat(65),
          wrappedBy: alice.id,
        },
      ],
    },
  });
  assert.equal(tooLongIv.status, 400);
  assert.equal(tooLongIv.body.error.code, 'VALIDATION_ERROR');
});

test('health check answers ok', async () => {
  const res = await request('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok' });
});

test('unknown routes return the shared NOT_FOUND shape', async () => {
  const res = await request('GET', '/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'NOT_FOUND');
});
