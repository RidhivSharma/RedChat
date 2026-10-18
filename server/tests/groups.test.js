// Phase 8 — group management: admin-only membership changes, the
// at-least-one-admin invariant, system activity messages and the socket
// events (conversation:updated / conversation:new / conversation:removed).
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
let dave;

let directId; // alice <-> bob
let groupId; // alice (admin) + bob + carol → dave added in test 1
let leaveGroupId; // alice (admin) + bob + carol, used for leave/remove tests
let smallGroupId; // alice (admin) + dave, used for "removed stops receiving"

const clients = [];
let aliceSocket;
let bobSocket;
let carolSocket;
let daveSocket;

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

/** Sends a plaintext group message through the socket and returns its shape. */
async function sendGroupMessage(socket, conversationId, clientId) {
  const ack = await emitAck(socket, 'message:send', {
    conversationId,
    ciphertext: `hello-${clientId}`,
    iv: '',
    keyVersion: 1,
    encrypted: false,
    clientId,
  });
  assert.equal(ack.ok, true, `sending ${clientId} failed: ${JSON.stringify(ack)}`);
  return ack.data.message;
}

/** The stored (plain text) system messages of a conversation, oldest first. */
async function systemTexts(conversationId) {
  const rows = await Message.find({ conversationId, type: 'system' })
    .sort({ createdAt: 1, _id: 1 })
    .lean();
  return rows;
}

before(async () => {
  await connectDB();
  await dropTestDatabase();

  const started = await startTestServer(app);
  server = started.server;
  baseUrl = started.baseUrl;
  request = createRequester(baseUrl);
  ioServer = attachSockets(server);

  alice = await registerUser('alice_group', 'Alice');
  bob = await registerUser('bob_group', 'Bob');
  carol = await registerUser('carol_group', 'Carol');
  dave = await registerUser('dave_group', 'Dave');

  aliceSocket = connect(alice.token);
  bobSocket = connect(bob.token);
  carolSocket = connect(carol.token);
  daveSocket = connect(dave.token);
  await Promise.all(
    [aliceSocket, bobSocket, carolSocket, daveSocket].map((socket) => waitFor(socket, 'connect'))
  );

  const direct = await request('POST', '/api/conversations/direct', {
    token: alice.token,
    json: { userId: bob.id },
  });
  assert.equal(direct.status, 201);
  directId = direct.body.conversation.id;

  const group = await request('POST', '/api/conversations/group', {
    token: alice.token,
    json: { name: 'Wave Crew', memberIds: [bob.id, carol.id] },
  });
  assert.equal(group.status, 201, JSON.stringify(group.body));
  groupId = group.body.conversation.id;
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

test('groups: adding members is admin-only and notifies the room + the newcomers', async () => {
  // Bob and Carol are regular members: neither may add people or remove others.
  const asBob = await request('POST', `/api/conversations/${groupId}/members`, {
    token: bob.token,
    json: { userIds: [dave.id] },
  });
  assert.equal(asBob.status, 403);
  assert.equal(asBob.body.error.code, 'NOT_GROUP_ADMIN');

  const bobRemovingCarol = await request(
    'DELETE',
    `/api/conversations/${groupId}/members/${carol.id}`,
    { token: bob.token }
  );
  assert.equal(bobRemovingCarol.status, 403);
  assert.equal(bobRemovingCarol.body.error.code, 'NOT_GROUP_ADMIN');

  // A non-member cannot even see the group, let alone manage it.
  const asDave = await request('POST', `/api/conversations/${groupId}/members`, {
    token: dave.token,
    json: { userIds: [carol.id] },
  });
  assert.equal(asDave.status, 403);
  assert.equal(asDave.body.error.code, 'NOT_A_MEMBER');

  // Group-only actions are rejected on direct conversations.
  const directRename = await request('PATCH', `/api/conversations/${directId}`, {
    token: alice.token,
    json: { name: 'Not a group' },
  });
  assert.equal(directRename.status, 400);
  assert.equal(directRename.body.error.code, 'NOT_A_GROUP');

  const directAdd = await request('POST', `/api/conversations/${directId}/members`, {
    token: alice.token,
    json: { userIds: [carol.id] },
  });
  assert.equal(directAdd.status, 400);
  assert.equal(directAdd.body.error.code, 'NOT_A_GROUP');

  // The admin adds Dave: existing members get conversation:updated, Dave's
  // sockets join the room and he gets conversation:new, and the activity line
  // is broadcast as a plain system message.
  const bobSeesUpdate = waitFor(bobSocket, 'conversation:updated');
  const daveGetsNew = waitFor(daveSocket, 'conversation:new');
  const bobGetsSystemMessage = waitFor(bobSocket, 'message:new');

  const added = await request('POST', `/api/conversations/${groupId}/members`, {
    token: alice.token,
    json: { userIds: [dave.id] },
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual(
    added.body.conversation.members.map((member) => member.id).sort(),
    [alice.id, bob.id, carol.id, dave.id].sort()
  );

  const update = await bobSeesUpdate;
  assert.equal(update.conversation.id, groupId);
  assert.ok(
    update.conversation.members.some((member) => member.id === dave.id),
    'the updated member list includes the newcomer'
  );

  const newcomer = await daveGetsNew;
  assert.equal(newcomer.conversation.id, groupId);
  assert.equal(newcomer.conversation.unreadCount, 0);

  const systemEvent = await bobGetsSystemMessage;
  assert.equal(systemEvent.message.type, 'system');
  assert.equal(systemEvent.message.ciphertext, 'Alice added Dave');
  assert.equal(systemEvent.message.encrypted, false);

  // Stored as plain text, no iv, never receipt-tracked.
  const stored = await Message.findOne({ conversationId: groupId, clientId: /^system:/ }).lean();
  assert.equal(stored.type, 'system');
  assert.equal(stored.ciphertext, 'Alice added Dave');
  assert.equal(stored.encrypted, false);
  assert.equal(stored.iv, null);
  assert.deepEqual(stored.deliveredTo, []);
  assert.deepEqual(stored.readBy, []);

  // System messages do not create unread badges for the new member.
  const daveList = await request('GET', '/api/conversations', { token: dave.token });
  const daveGroup = daveList.body.conversations.find((c) => c.id === groupId);
  assert.equal(daveGroup.unreadCount, 0, '“Alice added Dave” is not an unread message');

  // Dave is really in the room now: his message reaches Alice.
  const aliceGetsDave = waitFor(aliceSocket, 'message:new');
  const fromDave = await sendGroupMessage(daveSocket, groupId, 'dave-1');
  const received = await aliceGetsDave;
  assert.equal(received.message.id, fromDave.id);
  assert.equal(received.message.sender, dave.id);

  // Re-adding an existing member is a no-op without a duplicate activity line.
  const again = await request('POST', `/api/conversations/${groupId}/members`, {
    token: alice.token,
    json: { userIds: [dave.id] },
  });
  assert.equal(again.status, 200);
  assert.equal((await systemTexts(groupId)).length, 1, 'no duplicate “added” message');

  // Unknown users and duplicates-in-payload are rejected.
  const unknown = await request('POST', `/api/conversations/${groupId}/members`, {
    token: alice.token,
    json: { userIds: [new mongoose.Types.ObjectId().toString()] },
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, 'UNKNOWN_MEMBERS');

  const duplicated = await request('POST', `/api/conversations/${groupId}/members`, {
    token: alice.token,
    json: { userIds: [carol.id, carol.id] },
  });
  assert.equal(duplicated.status, 400);
  assert.equal(duplicated.body.error.code, 'VALIDATION_ERROR');

  const emptyList = await request('POST', `/api/conversations/${groupId}/members`, {
    token: alice.token,
    json: { userIds: [] },
  });
  assert.equal(emptyList.status, 400);
});

test('groups: rename and promote are admin-only and recorded as system messages', async () => {
  const carolRenames = await request('PATCH', `/api/conversations/${groupId}`, {
    token: carol.token,
    json: { name: 'Hacked name' },
  });
  assert.equal(carolRenames.status, 403);
  assert.equal(carolRenames.body.error.code, 'NOT_GROUP_ADMIN');

  const bobPromotes = await request('POST', `/api/conversations/${groupId}/admins`, {
    token: bob.token,
    json: { userId: carol.id },
  });
  assert.equal(bobPromotes.status, 403);
  assert.equal(bobPromotes.body.error.code, 'NOT_GROUP_ADMIN');

  // The admin renames the group; the room hears about it.
  const bobSeesRename = waitFor(bobSocket, 'conversation:updated');
  const renamed = await request('PATCH', `/api/conversations/${groupId}`, {
    token: alice.token,
    json: { name: 'Wave Crew 2' },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.conversation.name, 'Wave Crew 2');
  assert.equal((await bobSeesRename).conversation.name, 'Wave Crew 2');

  // And promotes Bob.
  const promoted = await request('POST', `/api/conversations/${groupId}/admins`, {
    token: alice.token,
    json: { userId: bob.id },
  });
  assert.equal(promoted.status, 200);
  assert.deepEqual(
    promoted.body.conversation.admins.slice().sort(),
    [alice.id, bob.id].sort()
  );

  const texts = (await systemTexts(groupId)).map((message) => message.ciphertext);
  assert.ok(texts.includes('Alice renamed the group to “Wave Crew 2”'), texts.join(' | '));
  assert.ok(texts.includes('Alice made Bob an admin'), texts.join(' | '));

  // Bob is an admin now: he can rename too.
  const bobRenames = await request('PATCH', `/api/conversations/${groupId}`, {
    token: bob.token,
    json: { name: 'Wave Crew 3' },
  });
  assert.equal(bobRenames.status, 200);
  assert.equal(bobRenames.body.conversation.name, 'Wave Crew 3');

  // Promoting a non-member is a 404; bad payloads are 400.
  const stranger = await request('POST', `/api/conversations/${groupId}/admins`, {
    token: alice.token,
    json: { userId: new mongoose.Types.ObjectId().toString() },
  });
  assert.equal(stranger.status, 404);
  assert.equal(stranger.body.error.code, 'MEMBER_NOT_FOUND');

  const badName = await request('PATCH', `/api/conversations/${groupId}`, {
    token: alice.token,
    json: { name: '   ' },
  });
  assert.equal(badName.status, 400);
});

test('groups: leaving as the last admin promotes the earliest remaining member', async () => {
  const created = await request('POST', '/api/conversations/group', {
    token: alice.token,
    json: { name: 'Leavers', memberIds: [bob.id, carol.id] },
  });
  assert.equal(created.status, 201);
  leaveGroupId = created.body.conversation.id;

  const bobSeesUpdate = waitFor(bobSocket, 'conversation:updated');
  const aliceRemoved = waitFor(aliceSocket, 'conversation:removed');

  const left = await request('DELETE', `/api/conversations/${leaveGroupId}/members/${alice.id}`, {
    token: alice.token,
  });
  assert.equal(left.status, 200, JSON.stringify(left.body));
  assert.equal(left.body.left, true);
  assert.equal(left.body.conversationId, leaveGroupId);

  const removedEvent = await aliceRemoved;
  assert.equal(removedEvent.conversationId, leaveGroupId);
  assert.equal(removedEvent.left, true);

  const update = await bobSeesUpdate;
  assert.deepEqual(
    update.conversation.members.map((member) => member.id).sort(),
    [bob.id, carol.id].sort()
  );
  assert.deepEqual(update.conversation.admins, [bob.id], 'Bob (earliest remaining) is promoted');

  const texts = (await systemTexts(leaveGroupId)).map((message) => message.ciphertext);
  assert.ok(texts.includes('Alice left'), texts.join(' | '));
  assert.ok(texts.includes('Bob is now an admin'), texts.join(' | '));

  // Alice's socket left the room: new messages no longer reach her.
  let aliceHeard = false;
  const aliceListener = () => {
    aliceHeard = true;
  };
  aliceSocket.on('message:new', aliceListener);
  await sendGroupMessage(bobSocket, leaveGroupId, 'leave-1');
  await delay(300);
  aliceSocket.off('message:new', aliceListener);
  assert.equal(aliceHeard, false, 'a removed member must not receive messages');

  // She also cannot read or send in that group anymore.
  const aliceHistory = await request('GET', `/api/conversations/${leaveGroupId}/messages`, {
    token: alice.token,
  });
  assert.equal(aliceHistory.status, 403);
  assert.equal(aliceHistory.body.error.code, 'NOT_A_MEMBER');

  const aliceSend = await emitAck(aliceSocket, 'message:send', {
    conversationId: leaveGroupId,
    ciphertext: 'still here?',
    iv: '',
    encrypted: false,
    clientId: 'leave-2',
  });
  assert.equal(aliceSend.ok, false);
  assert.equal(aliceSend.error.code, 'NOT_A_MEMBER');

  // Carol is not an admin: she cannot remove Bob, and a missing member is 404.
  const carolRemovesBob = await request(
    'DELETE',
    `/api/conversations/${leaveGroupId}/members/${bob.id}`,
    { token: carol.token }
  );
  assert.equal(carolRemovesBob.status, 403);
  assert.equal(carolRemovesBob.body.error.code, 'NOT_GROUP_ADMIN');

  const removeMissing = await request(
    'DELETE',
    `/api/conversations/${leaveGroupId}/members/${new mongoose.Types.ObjectId().toString()}`,
    { token: bob.token }
  );
  assert.equal(removeMissing.status, 404);
  assert.equal(removeMissing.body.error.code, 'MEMBER_NOT_FOUND');

  // The new admin removes Carol; Carol's sockets leave the room.
  const carolRemoved = waitFor(carolSocket, 'conversation:removed');
  const bobRemovesCarol = await request(
    'DELETE',
    `/api/conversations/${leaveGroupId}/members/${carol.id}`,
    { token: bob.token }
  );
  assert.equal(bobRemovesCarol.status, 200);
  const carolEvent = await carolRemoved;
  assert.equal(carolEvent.conversationId, leaveGroupId);
  assert.equal(carolEvent.left, false, 'an admin removal is not a voluntary exit');

  const carolHistory = await request('GET', `/api/conversations/${leaveGroupId}/messages`, {
    token: carol.token,
  });
  assert.equal(carolHistory.status, 403);

  // Bob is the last member and remains an admin.
  const bobView = await request('GET', `/api/conversations/${leaveGroupId}`, {
    token: bob.token,
  });
  assert.equal(bobView.status, 200);
  assert.deepEqual(bobView.body.conversation.admins, [bob.id]);
  assert.equal(bobView.body.conversation.members.length, 1);
});

test('groups: a removed member stops receiving messages and cannot send', async () => {
  const created = await request('POST', '/api/conversations/group', {
    token: alice.token,
    json: { name: 'Pair', memberIds: [carol.id, dave.id] },
  });
  assert.equal(created.status, 201);
  smallGroupId = created.body.conversation.id;
  // Carol + Dave are the two non-creator members; Dave gets removed below.
  assert.deepEqual(
    created.body.conversation.members.map((member) => member.id).sort(),
    [alice.id, carol.id, dave.id].sort()
  );

  const daveRemoved = waitFor(daveSocket, 'conversation:removed');
  const removed = await request(
    'DELETE',
    `/api/conversations/${smallGroupId}/members/${dave.id}`,
    { token: alice.token }
  );
  assert.equal(removed.status, 200);
  const event = await daveRemoved;
  assert.equal(event.conversationId, smallGroupId);
  assert.equal(event.left, false);

  let daveHeard = false;
  const listener = () => {
    daveHeard = true;
  };
  daveSocket.on('message:new', listener);
  const sent = await sendGroupMessage(aliceSocket, smallGroupId, 'pair-1');
  await delay(300);
  daveSocket.off('message:new', listener);

  assert.equal(daveHeard, false, 'the removed member must not receive the message');
  assert.ok(sent.id, 'the remaining members still get messages');

  const history = await request('GET', `/api/conversations/${smallGroupId}/messages`, {
    token: dave.token,
  });
  assert.equal(history.status, 403);
  assert.equal(history.body.error.code, 'NOT_A_MEMBER');

  const send = await emitAck(daveSocket, 'message:send', {
    conversationId: smallGroupId,
    ciphertext: 'let me back in',
    iv: '',
    encrypted: false,
    clientId: 'pair-2',
  });
  assert.equal(send.ok, false);
  assert.equal(send.error.code, 'NOT_A_MEMBER');

  const texts = (await systemTexts(smallGroupId)).map((message) => message.ciphertext);
  assert.ok(texts.includes('Alice removed Dave'), texts.join(' | '));
});

test('groups: leaving the last member deletes the empty group', async () => {
  // The "Pair" group now holds only Alice + Carol; Carol leaves herself…
  const carolLeaves = await request(
    'DELETE',
    `/api/conversations/${smallGroupId}/members/${carol.id}`,
    { token: carol.token }
  );
  assert.equal(carolLeaves.status, 200);
  assert.equal(carolLeaves.body.left, true);

  // …then Alice (last member) leaves and the group disappears for good.
  const removed = waitFor(aliceSocket, 'conversation:removed');
  const aliceLeaves = await request(
    'DELETE',
    `/api/conversations/${smallGroupId}/members/${alice.id}`,
    { token: alice.token }
  );
  assert.equal(aliceLeaves.status, 200);
  assert.equal(aliceLeaves.body.left, true);
  await removed;

  const gone = await request('GET', `/api/conversations/${smallGroupId}`, {
    token: alice.token,
  });
  assert.equal(gone.status, 404);
  assert.equal(gone.body.error.code, 'CONVERSATION_NOT_FOUND');
  assert.equal(
    await Message.countDocuments({ conversationId: smallGroupId }),
    0,
    'an empty group leaves no messages behind'
  );
});
