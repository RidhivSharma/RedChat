// Legacy-plaintext contract, pinned end to end: the server still accepts and
// stores plaintext messages (`encrypted: false`, EMPTY `iv`) so data created
// before the E2EE phase keeps working and the REQUIRE_E2EE gate has something
// real to reject. The CURRENT web client never sends this shape — it always
// encrypts (see client/src/utils/crypto); this file only proves the socket and
// REST layers keep accepting the legacy payload, deduplicate retries, and keep
// rejecting an empty iv once `encrypted` is true.
import './helpers/setup.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { io as createSocket } from 'socket.io-client';
import app from '../src/app.js';
import { connectDB } from '../src/config/db.js';
import { Message } from '../src/models/index.js';
import { attachSockets } from '../src/sockets/index.js';
import {
  createRequester,
  dropTestDatabase,
  startTestServer,
  stopTestServer,
} from './helpers/harness.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let server;
let ioServer;
let baseUrl;
let request;

let alice;
let bob;
let conversationId;

const clients = [];

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
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for "${event}"`)),
      timeoutMs
    );
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
  ioServer = attachSockets(server);

  alice = await registerUser('alice_plain', 'Alice Plain');
  bob = await registerUser('bob_plain', 'Bob Plain');

  const created = await request('POST', '/api/conversations/direct', {
    token: alice.token,
    json: { userId: bob.id },
  });
  assert.equal(created.status, 201);
  conversationId = created.body.conversation.id;
});

after(async () => {
  for (const client of clients) client.disconnect();
  await delay(250);
  ioServer.close();
  await stopTestServer(server);

  if (mongoose.connection.readyState !== 0) {
    await dropTestDatabase();
    await mongoose.disconnect();
  }
});

test('plaintext client send (encrypted: false, iv: "") is accepted, stored verbatim and broadcast', async () => {
  const aliceSocket = connect(alice.token);
  const bobSocket = connect(bob.token);
  await Promise.all([waitFor(aliceSocket, 'connect'), waitFor(bobSocket, 'connect')]);

  const clientId = 'client-contract-1';
  const payload = {
    conversationId,
    clientId,
    ciphertext: 'hello from the web client',
    iv: '',
    keyVersion: 1,
    encrypted: false,
  };

  const bobReceives = waitFor(bobSocket, 'message:new');
  const ack = await emitAck(aliceSocket, 'message:send', payload);

  assert.equal(ack.ok, true, `unexpected ack: ${JSON.stringify(ack)}`);
  assert.equal(ack.data.message.clientId, clientId);
  assert.equal(ack.data.message.ciphertext, 'hello from the web client');
  assert.equal(ack.data.message.encrypted, false);
  assert.equal(ack.data.message.iv, '', 'the empty iv survives the round trip');

  const received = await bobReceives;
  assert.equal(received.message.id, ack.data.message.id);

  const stored = await Message.findById(ack.data.message.id).lean();
  assert.equal(stored.ciphertext, 'hello from the web client');
  assert.equal(stored.encrypted, false);

  // Retry with the same clientId (the client's "Retry" button): deduplicated.
  const retry = await emitAck(aliceSocket, 'message:send', payload);
  assert.equal(retry.ok, true);
  assert.equal(retry.data.message.id, ack.data.message.id);
  assert.equal(await Message.countDocuments({ clientId }), 1);

  // The history endpoint returns it as an unencrypted message as well.
  const history = await request('GET', `/api/conversations/${conversationId}/messages`, {
    token: bob.token,
  });
  assert.equal(history.status, 200);
  const fromHistory = history.body.messages.find((message) => message.id === ack.data.message.id);
  assert.equal(fromHistory.encrypted, false);
  assert.equal(fromHistory.ciphertext, 'hello from the web client');
});

test('an empty iv is still rejected while encrypted is true', async () => {
  const socket = connect(alice.token);
  await waitFor(socket, 'connect');

  const ack = await emitAck(socket, 'message:send', {
    conversationId,
    clientId: 'client-contract-2',
    ciphertext: 'cipher-blob',
    iv: '',
    keyVersion: 1,
    encrypted: true,
  });

  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, 'VALIDATION_ERROR');
  assert.match(ack.error.message, /iv/);
});

test('the REST fallback also accepts the same plaintext shape', async () => {
  const res = await request('POST', `/api/conversations/${conversationId}/messages`, {
    token: alice.token,
    json: {
      ciphertext: 'rest plaintext',
      iv: '',
      encrypted: false,
      clientId: 'client-contract-3',
    },
  });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.message.encrypted, false);
  assert.equal(res.body.message.ciphertext, 'rest plaintext');
});
