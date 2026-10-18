import './helpers/setup.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { io as createSocket } from 'socket.io-client';
import app from '../src/app.js';
import { connectDB } from '../src/config/db.js';
import { User } from '../src/models/index.js';
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
let conversationId; // alice <-> bob

const clients = [];
let aliceSocket;
let bobSocket;
let carolSocket;

/** Opens an authenticated (or not) socket client and tracks it for cleanup. */
function connect(token) {
  const options = {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  };
  if (token !== undefined) {
    options.auth = { token };
  } else {
    options.auth = {};
  }
  const socket = createSocket(baseUrl, options);
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

  alice = await registerUser('alice_sock', 'Alice');
  bob = await registerUser('bob_sock', 'Bob');
  carol = await registerUser('carol_sock', 'Carol');

  // The conversation the message tests use (created while no sockets exist —
  // announceConversationCreated is a safe no-op then).
  const created = await request('POST', '/api/conversations/direct', {
    token: alice.token,
    json: { userId: bob.id },
  });
  assert.equal(created.status, 201);
  conversationId = created.body.conversation.id;
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

test('socket auth: missing and invalid tokens are rejected with clear codes', async () => {
  const noToken = connect();
  const noTokenError = waitFor(noToken, 'connect_error');
  const missing = await noTokenError;
  assert.equal(missing.data?.code, 'AUTH_REQUIRED');
  assert.match(missing.message, /Authentication required/);

  const badToken = connect('definitely-not-a-jwt');
  const badTokenError = waitFor(badToken, 'connect_error');
  const invalid = await badTokenError;
  assert.equal(invalid.data?.code, 'INVALID_TOKEN');
  assert.match(invalid.message, /Invalid token/);
});

test('presence: snapshot on connect and update for conversation partners', async () => {
  aliceSocket = connect(alice.token);
  const aliceSnapshot = waitFor(aliceSocket, 'presence:snapshot');
  await waitFor(aliceSocket, 'connect');

  const snapshotForAlice = await aliceSnapshot;
  assert.deepEqual(
    snapshotForAlice.users,
    [{ userId: bob.id, online: false }],
    'alice only shares the conversation with bob, who is offline'
  );

  const aliceSeesBobOnline = waitFor(aliceSocket, 'presence:update');
  bobSocket = connect(bob.token);
  const bobSnapshot = waitFor(bobSocket, 'presence:snapshot');
  await waitFor(bobSocket, 'connect');

  const snapshotForBob = await bobSnapshot;
  assert.deepEqual(snapshotForBob.users, [{ userId: alice.id, online: true }]);

  const update = await aliceSeesBobOnline;
  assert.equal(update.userId, bob.id);
  assert.equal(update.online, true);
});

test('message:send is delivered to the other member and acked with the saved message', async () => {
  const bobReceives = waitFor(bobSocket, 'message:new');

  const ack = await emitAck(aliceSocket, 'message:send', {
    conversationId,
    ciphertext: 'cipher-text-1',
    iv: 'iv-1',
    keyVersion: 1,
    encrypted: true,
    clientId: 'socket-msg-1',
  });

  assert.equal(ack.ok, true, `unexpected ack: ${JSON.stringify(ack)}`);
  assert.equal(ack.data.message.ciphertext, 'cipher-text-1');
  assert.equal(ack.data.message.sender, alice.id);
  assert.equal(ack.data.message.conversationId, conversationId);

  const received = await bobReceives;
  assert.equal(received.message.id, ack.data.message.id);
  assert.equal(received.message.clientId, 'socket-msg-1');

  // Bob was online, so the message is marked delivered for him.
  assert.ok(
    ack.data.message.deliveredTo.some((receipt) => receipt.user === bob.id),
    'online recipient is marked as delivered'
  );
});

test('message:send validates payloads and checks membership', async () => {
  const badPayload = await emitAck(aliceSocket, 'message:send', {
    conversationId,
    ciphertext: 'x',
    iv: 'iv',
    // clientId missing on purpose
  });
  assert.equal(badPayload.ok, false);
  assert.equal(badPayload.error.code, 'VALIDATION_ERROR');
  assert.match(badPayload.error.message, /clientId/);

  carolSocket = connect(carol.token);
  await waitFor(carolSocket, 'connect');

  const notMember = await emitAck(carolSocket, 'message:send', {
    conversationId,
    ciphertext: 'sneaky',
    iv: 'iv',
    clientId: 'carol-1',
  });
  assert.equal(notMember.ok, false);
  assert.equal(notMember.error.code, 'NOT_A_MEMBER');
});

test('typing:start/stop relay to other members only', async () => {
  const bobSeesTyping = waitFor(bobSocket, 'typing');
  const startAck = await emitAck(aliceSocket, 'typing:start', { conversationId });
  assert.equal(startAck.ok, true);

  const typing = await bobSeesTyping;
  assert.deepEqual(typing, { conversationId, userId: alice.id, isTyping: true });

  // The sender's own sockets must not receive their typing events.
  let selfReceived = false;
  const selfListener = () => {
    selfReceived = true;
  };
  aliceSocket.on('typing', selfListener);

  const bobSeesStop = waitFor(bobSocket, 'typing');
  await emitAck(aliceSocket, 'typing:stop', { conversationId });
  const stopped = await bobSeesStop;
  assert.equal(stopped.isTyping, false);

  await delay(250);
  aliceSocket.off('typing', selfListener);
  assert.equal(selfReceived, false, 'sender must not receive their own typing events');
});

test('message:delete removes the content and notifies the room', async () => {
  const sendAck = await emitAck(aliceSocket, 'message:send', {
    conversationId,
    ciphertext: 'to-delete',
    iv: 'iv-del',
    clientId: 'socket-del-1',
  });
  assert.equal(sendAck.ok, true);
  const messageId = sendAck.data.message.id;

  const bobSeesDeletion = waitFor(bobSocket, 'message:deleted');
  const deleteAck = await emitAck(aliceSocket, 'message:delete', { messageId });

  assert.equal(deleteAck.ok, true, `unexpected ack: ${JSON.stringify(deleteAck)}`);
  assert.equal(deleteAck.data.message.deletedForEveryone, true);
  assert.equal(deleteAck.data.message.ciphertext, null);

  const deletion = await bobSeesDeletion;
  assert.deepEqual(deletion, { conversationId, messageId });
});

test('new conversations notify members and their sockets join the room', async () => {
  const aliceSeesConversation = waitFor(aliceSocket, 'conversation:new');
  const carolSeesConversation = waitFor(carolSocket, 'conversation:new');

  const created = await request('POST', '/api/conversations/direct', {
    token: alice.token,
    json: { userId: carol.id },
  });
  assert.equal(created.status, 201);
  const newConversationId = created.body.conversation.id;

  const aliceEvent = await aliceSeesConversation;
  const carolEvent = await carolSeesConversation;
  assert.equal(aliceEvent.conversation.id, newConversationId);
  assert.equal(carolEvent.conversation.id, newConversationId);
  assert.deepEqual(
    carolEvent.conversation.members.map((member) => member.id).sort(),
    [alice.id, carol.id].sort()
  );

  // Carol's socket joined the new conv room: a message reaches her.
  const carolReceivesMessage = waitFor(carolSocket, 'message:new');
  const ack = await emitAck(aliceSocket, 'message:send', {
    conversationId: newConversationId,
    ciphertext: 'hi-carol',
    iv: 'iv-carol',
    clientId: 'socket-carol-1',
  });
  assert.equal(ack.ok, true);

  const message = await carolReceivesMessage;
  assert.equal(message.message.conversationId, newConversationId);
  assert.equal(message.message.ciphertext, 'hi-carol');
});

test('message:send is rate limited per socket (20 messages / 10s)', async () => {
  // A fresh socket gets a fresh limiter.
  const spammer = connect(carol.token);
  await waitFor(spammer, 'connect');

  const payload = (i) => ({
    conversationId, // carol is NOT a member — no rows are written
    ciphertext: `spam-${i}`,
    iv: 'iv',
    clientId: `spam-${i}`,
  });

  for (let i = 1; i <= 20; i += 1) {
    const ack = await emitAck(spammer, 'message:send', payload(i));
    assert.equal(ack.ok, false, `attempt ${i} must not succeed`);
    assert.equal(ack.error.code, 'NOT_A_MEMBER', `attempt ${i} should pass the limiter`);
  }

  const blocked = await emitAck(spammer, 'message:send', payload(21));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'RATE_LIMITED');
  assert.match(blocked.error.message, /too quickly/i);
});

test('presence: a user stays online until their last socket disconnects', async () => {
  // Bob opens a second tab while the first one (from earlier tests) is open.
  const secondBob = connect(bob.token);
  await waitFor(secondBob, 'connect');

  let wentOffline = false;
  const offlineListener = (payload) => {
    if (payload.userId === bob.id && payload.online === false) wentOffline = true;
  };
  aliceSocket.on('presence:update', offlineListener);

  // Closing one of two tabs must NOT announce offline.
  bobSocket.disconnect();
  await delay(300);
  assert.equal(wentOffline, false, 'still online while another tab is connected');

  // Closing the last tab does.
  const aliceSeesBobOffline = waitFor(aliceSocket, 'presence:update');
  secondBob.disconnect();

  const update = await aliceSeesBobOffline;
  aliceSocket.off('presence:update', offlineListener);
  assert.equal(update.userId, bob.id);
  assert.equal(update.online, false);
  assert.ok(update.lastSeen, 'lastSeen is included in the offline update');

  // The same timestamp is persisted on the user document.
  const bobDoc = await User.findById(bob.id).select('lastSeen').lean();
  assert.ok(Date.now() - bobDoc.lastSeen.getTime() < 60_000, 'lastSeen was updated in the DB');
});
