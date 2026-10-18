// Read/delivery receipt flow: connect-time delivery catch-up, message:delivered,
// message:read (bulk, read-implies-delivered) and the unread counts behind
// GET /api/conversations.
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
let carol;
let conversationId; // alice <-> bob, the conversation most tests use

const clients = [];
let aliceSocket;
let bobSocket;
let carolSocket;

/** Opens an authenticated socket client and tracks it for cleanup. */
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

/** Waits for exactly `count` events of one type (order preserved). */
function waitForCount(socket, event, count, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const seen = [];
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out waiting for ${count} "${event}" events (got ${seen.length})`));
    }, timeoutMs);

    function listener(payload) {
      seen.push(payload);
      if (seen.length >= count) {
        clearTimeout(timer);
        socket.off(event, listener);
        resolve(seen);
      }
    }

    socket.on(event, listener);
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

/** Sends a plaintext message and returns the saved message from the ack. */
async function sendMessage(socket, clientId, target = conversationId) {
  const ack = await emitAck(socket, 'message:send', {
    conversationId: target,
    ciphertext: `hello-${clientId}`,
    iv: 'iv',
    keyVersion: 1,
    encrypted: true,
    clientId,
  });
  assert.equal(ack.ok, true, `sending ${clientId} failed: ${JSON.stringify(ack)}`);
  return ack.data.message;
}

function unreadCount(conversations, id) {
  return conversations.find((conversation) => conversation.id === id)?.unreadCount;
}

before(async () => {
  await connectDB();
  await dropTestDatabase();

  const started = await startTestServer(app);
  server = started.server;
  baseUrl = started.baseUrl;
  request = createRequester(baseUrl);
  ioServer = attachSockets(server);

  alice = await registerUser('alice_receipt', 'Alice');
  bob = await registerUser('bob_receipt', 'Bob');
  carol = await registerUser('carol_receipt', 'Carol');

  const created = await request('POST', '/api/conversations/direct', {
    token: alice.token,
    json: { userId: bob.id },
  });
  assert.equal(created.status, 201);
  conversationId = created.body.conversation.id;

  // Alice is online for every test; Bob's socket is opened by the first test
  // so his messages start out undelivered.
  aliceSocket = connect(alice.token);
  await waitFor(aliceSocket, 'connect');
});

after(async () => {
  for (const client of clients) {
    client.disconnect();
  }
  await delay(250); // let the serverside disconnect handlers finish
  ioServer.close();
  await stopTestServer(server);

  if (mongoose.connection.readyState !== 0) {
    await dropTestDatabase();
    await mongoose.disconnect();
  }
});

test('connect-time catch-up marks pending messages delivered and notifies the sender', async () => {
  const m1 = await sendMessage(aliceSocket, 'receipt-1');
  const m2 = await sendMessage(aliceSocket, 'receipt-2');
  assert.deepEqual(m1.deliveredTo, [], 'Bob is offline when the message is sent');
  assert.deepEqual(m2.deliveredTo, []);

  // Listen before Bob connects: the catch-up fires during his handshake.
  const statusesPromise = waitForCount(aliceSocket, 'message:status', 2);

  bobSocket = connect(bob.token);
  await waitFor(bobSocket, 'connect');
  const [first, second] = await statusesPromise;

  for (const status of [first, second]) {
    assert.equal(status.conversationId, conversationId);
    assert.deepEqual(status.readBy, []);
    assert.deepEqual(
      status.deliveredTo.map((receipt) => receipt.user),
      [bob.id],
      'the connecting user is the new recipient'
    );
    assert.ok(status.deliveredTo[0].at, 'the receipt carries a timestamp');
  }
  assert.deepEqual(
    new Set([first.messageId, second.messageId]),
    new Set([m1.id, m2.id]),
    'both pending messages are reported'
  );

  const stored = await Message.find({ _id: { $in: [m1.id, m2.id] } }).lean();
  for (const message of stored) {
    assert.deepEqual(
      message.deliveredTo.map((receipt) => receipt.user.toString()),
      [bob.id]
    );
  }
});

test('message:delivered marks the given messages, is idempotent and notifies the room', async () => {
  const message = await Message.findOne({ clientId: 'receipt-1' }).lean();
  // Simulate a delivery confirmation that was lost on the way.
  await Message.updateOne({ _id: message._id }, { $set: { deliveredTo: [] } });

  const aliceSeesStatus = waitFor(aliceSocket, 'message:status');
  const ack = await emitAck(bobSocket, 'message:delivered', {
    conversationId,
    messageIds: [message._id.toString()],
  });

  assert.equal(ack.ok, true, `unexpected ack: ${JSON.stringify(ack)}`);
  assert.equal(ack.data.delivered, 1);

  const status = await aliceSeesStatus;
  assert.equal(status.messageId, message._id.toString());
  assert.deepEqual(
    status.deliveredTo.map((receipt) => receipt.user),
    [bob.id]
  );

  // Repeating the same confirmation must not double-push the receipt.
  const again = await emitAck(bobSocket, 'message:delivered', {
    conversationId,
    messageIds: [message._id.toString()],
  });
  assert.equal(again.ok, true);
  assert.equal(again.data.delivered, 0);

  const stored = await Message.findById(message._id).lean();
  assert.equal(stored.deliveredTo.length, 1);
});

test('message:read marks every message up to the point read — and delivered', async () => {
  const m3 = await sendMessage(aliceSocket, 'receipt-3');
  const m4 = await sendMessage(aliceSocket, 'receipt-4');

  // m3's delivery mark is "lost" as well: a read implies delivered.
  await Message.updateOne({ _id: m3.id }, { $set: { deliveredTo: [] } });

  const aliceSeesRead = waitFor(aliceSocket, 'messages:read');
  const ack = await emitAck(bobSocket, 'message:read', {
    conversationId,
    upToMessageId: m4.id,
  });

  assert.equal(ack.ok, true, `unexpected ack: ${JSON.stringify(ack)}`);
  assert.equal(ack.data.readCount, 4, 'receipt-1 … receipt-4 are all from Alice');
  assert.equal(ack.data.deliveredCount, 1, 'only receipt-3 missed its delivery mark');
  assert.ok(ack.data.at, 'the ack carries the receipt timestamp');

  const read = await aliceSeesRead;
  assert.equal(read.conversationId, conversationId);
  assert.equal(read.userId, bob.id);
  assert.equal(read.upToMessageId, m4.id);
  assert.ok(read.upToMessageAt);
  assert.equal(read.readCount, 4);

  const stored = await Message.find({
    clientId: { $in: ['receipt-1', 'receipt-2', 'receipt-3', 'receipt-4'] },
  }).lean();
  assert.equal(stored.length, 4);
  for (const message of stored) {
    assert.ok(
      message.readBy.some((receipt) => receipt.user.toString() === bob.id),
      `${message.clientId} is read by Bob`
    );
    assert.ok(
      message.deliveredTo.some((receipt) => receipt.user.toString() === bob.id),
      `${message.clientId} is delivered to Bob (a read implies delivered)`
    );
  }
});

test('unread counts follow the read point (GET /api/conversations)', async () => {
  let list = await request('GET', '/api/conversations', { token: bob.token });
  assert.equal(list.status, 200);
  assert.equal(unreadCount(list.body.conversations, conversationId), 0);

  const m5 = await sendMessage(aliceSocket, 'receipt-5');
  const m6 = await sendMessage(aliceSocket, 'receipt-6');

  list = await request('GET', '/api/conversations', { token: bob.token });
  assert.equal(unreadCount(list.body.conversations, conversationId), 2);

  const ack = await emitAck(bobSocket, 'message:read', {
    conversationId,
    upToMessageId: m5.id,
  });
  assert.equal(ack.ok, true);
  assert.equal(ack.data.readCount, 1, 'only receipt-5 is at or before the read point');

  list = await request('GET', '/api/conversations', { token: bob.token });
  assert.equal(unreadCount(list.body.conversations, conversationId), 1, 'receipt-6 stays unread');

  const history = await request('GET', `/api/conversations/${conversationId}/messages`, {
    token: bob.token,
  });
  const byId = new Map(history.body.messages.map((message) => [message.id, message]));
  assert.ok(byId.get(m5.id).readBy.some((receipt) => receipt.user === bob.id));
  assert.equal(byId.get(m6.id).readBy.length, 0);
});

test('message:read rejects non-members, foreign and unknown read points', async () => {
  carolSocket = connect(carol.token);
  await waitFor(carolSocket, 'connect');

  const notMember = await emitAck(carolSocket, 'message:read', {
    conversationId,
    upToMessageId: new mongoose.Types.ObjectId().toString(),
  });
  assert.equal(notMember.ok, false);
  assert.equal(notMember.error.code, 'NOT_A_MEMBER');

  const unknown = await emitAck(bobSocket, 'message:read', {
    conversationId,
    upToMessageId: new mongoose.Types.ObjectId().toString(),
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'VALIDATION_ERROR');

  // A read point from another conversation is rejected too.
  const otherConversation = await request('POST', '/api/conversations/direct', {
    token: alice.token,
    json: { userId: carol.id },
  });
  assert.equal(otherConversation.status, 201);
  const foreign = await sendMessage(
    aliceSocket,
    'receipt-foreign',
    otherConversation.body.conversation.id
  );
  const crossConversation = await emitAck(bobSocket, 'message:read', {
    conversationId,
    upToMessageId: foreign.id,
  });
  assert.equal(crossConversation.ok, false);
  assert.equal(crossConversation.error.code, 'VALIDATION_ERROR');

  const invalid = await emitAck(bobSocket, 'message:read', { conversationId });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'VALIDATION_ERROR');
  assert.match(invalid.error.message, /upToMessageId/);
});

test('groups: one member reading does not clear the others unread count', async () => {
  const created = await request('POST', '/api/conversations/group', {
    token: alice.token,
    json: { name: 'Receipt group', memberIds: [bob.id, carol.id] },
  });
  assert.equal(created.status, 201);
  const groupId = created.body.conversation.id;

  const gm = await sendMessage(aliceSocket, 'receipt-group-1', groupId);
  assert.equal(gm.deliveredTo.length, 2, 'Bob and Carol were online at send time');

  const aliceSeesRead = waitFor(aliceSocket, 'messages:read');
  const ack = await emitAck(bobSocket, 'message:read', {
    conversationId: groupId,
    upToMessageId: gm.id,
  });
  assert.equal(ack.ok, true);
  assert.equal(ack.data.readCount, 1);

  const read = await aliceSeesRead;
  assert.equal(read.conversationId, groupId);
  assert.equal(read.userId, bob.id);
  assert.equal(read.upToMessageId, gm.id);

  const bobList = await request('GET', '/api/conversations', { token: bob.token });
  assert.equal(unreadCount(bobList.body.conversations, groupId), 0);

  const carolList = await request('GET', '/api/conversations', { token: carol.token });
  assert.equal(unreadCount(carolList.body.conversations, groupId), 1, 'Carol has not read it');

  const stored = await Message.findById(gm.id).lean();
  assert.deepEqual(
    stored.readBy.map((receipt) => receipt.user.toString()),
    [bob.id]
  );
  assert.equal(stored.deliveredTo.length, 2);
});
