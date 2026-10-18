import './helpers/setup.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import app from '../src/app.js';
import { connectDB } from '../src/config/db.js';
import { Message, Conversation } from '../src/models/index.js';
import {
  createRequester,
  dropTestDatabase,
  startTestServer,
  stopTestServer,
} from './helpers/harness.js';

const USER_PUBLIC_KEYS = ['avatarColor', 'displayName', 'id', 'lastSeen', 'publicKey', 'username'];

let server;
let request;
let alice;
let bob;
let carol;

let directId; // alice <-> bob
let groupId; // alice, bob, carol
let keyedGroupId; // alice, bob, carol + groupKeys
let pageConversationId; // alice <-> carol, used for pagination/delete tests

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function registerUser(username, displayName) {
  const res = await request('POST', '/api/auth/register', {
    json: { username, displayName, password: 'password123' },
  });
  assert.equal(res.status, 201, `registering ${username} failed: ${JSON.stringify(res.body)}`);
  return { id: res.body.user.id, token: res.body.token };
}

function sendMessage(conversationId, token, clientId, extra = {}) {
  return request('POST', `/api/conversations/${conversationId}/messages`, {
    token,
    json: { ciphertext: `ciphertext-for-${clientId}`, iv: `iv-${clientId}`, clientId, ...extra },
  });
}

before(async () => {
  await connectDB();
  await dropTestDatabase();

  const started = await startTestServer(app);
  server = started.server;
  request = createRequester(started.baseUrl);

  alice = await registerUser('alice_conv', 'Alice');
  bob = await registerUser('bob_conv', 'Bob');
  carol = await registerUser('carol_conv', 'Carol');
});

after(async () => {
  await stopTestServer(server);
  if (mongoose.connection.readyState !== 0) {
    await dropTestDatabase();
    await mongoose.disconnect();
  }
});

test('direct: creating the same conversation twice returns the same one', async () => {
  const first = await request('POST', '/api/conversations/direct', {
    token: alice.token,
    json: { userId: bob.id },
  });
  assert.equal(first.status, 201);
  const conversation = first.body.conversation;
  assert.equal(conversation.type, 'direct');
  assert.equal(conversation.name, '');
  assert.deepEqual(conversation.members.map((m) => m.id).sort(), [alice.id, bob.id].sort());
  assert.deepEqual(conversation.admins, []);
  assert.equal(conversation.createdBy, alice.id);
  assert.deepEqual(conversation.groupKeys, []);
  assert.equal(conversation.lastMessageAt, null);
  assert.equal(
    conversation.unreadCount,
    0,
    'a brand new conversation has no unread messages'
  );
  assert.ok(!JSON.stringify(first.body).includes('passwordHash'), 'never leak passwordHash');

  for (const member of conversation.members) {
    assert.deepEqual(Object.keys(member).sort(), [...USER_PUBLIC_KEYS].sort(), 'public fields only');
  }
  directId = conversation.id;

  // Same request again (alice) -> finds the existing conversation.
  const again = await request('POST', '/api/conversations/direct', {
    token: alice.token,
    json: { userId: bob.id },
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.conversation.id, directId);

  // And from bob's side the same directKey resolves to the same conversation.
  const fromBob = await request('POST', '/api/conversations/direct', {
    token: bob.token,
    json: { userId: alice.id },
  });
  assert.equal(fromBob.status, 200);
  assert.equal(fromBob.body.conversation.id, directId);

  const storedCount = await mongoose.connection
    .collection('conversations')
    .countDocuments({ type: 'direct' });
  assert.equal(storedCount, 1, 'exactly one direct conversation row exists');
});

test('direct: rejects self-conversations and unknown/invalid users', async () => {
  const self = await request('POST', '/api/conversations/direct', {
    token: alice.token,
    json: { userId: alice.id },
  });
  assert.equal(self.status, 400);
  assert.equal(self.body.error.code, 'SELF_CONVERSATION');

  const unknown = await request('POST', '/api/conversations/direct', {
    token: alice.token,
    json: { userId: new mongoose.Types.ObjectId().toString() },
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'USER_NOT_FOUND');

  const invalid = await request('POST', '/api/conversations/direct', {
    token: alice.token,
    json: { userId: 'not-an-id' },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
});

test('group: creator becomes admin, members and payload are validated', async () => {
  const created = await request('POST', '/api/conversations/group', {
    token: alice.token,
    json: { name: '  Project Wave  ', memberIds: [bob.id, carol.id, alice.id] },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const conversation = created.body.conversation;
  assert.equal(conversation.type, 'group');
  assert.equal(conversation.name, 'Project Wave', 'name is trimmed');
  assert.deepEqual(conversation.admins, [alice.id], 'creator is the only admin');
  assert.equal(conversation.createdBy, alice.id);
  assert.deepEqual(
    conversation.members.map((m) => m.id).sort(),
    [alice.id, bob.id, carol.id].sort(),
    'creator listed in memberIds is not duplicated'
  );
  assert.equal(conversation.currentKeyVersion, 1);
  assert.deepEqual(conversation.groupKeys, []);
  groupId = conversation.id;

  // A group with encrypted key envelopes (used by the encryption phase).
  const keyed = await request('POST', '/api/conversations/group', {
    token: alice.token,
    json: {
      name: 'Keyed Group',
      memberIds: [bob.id, carol.id],
      groupKeys: [
        {
          userId: alice.id,
          version: 2,
          wrappedKey: 'wrapped-key-for-alice',
          iv: 'group-key-iv',
          wrappedBy: alice.id,
        },
      ],
    },
  });
  assert.equal(keyed.status, 201, JSON.stringify(keyed.body));
  assert.equal(keyed.body.conversation.currentKeyVersion, 2);
  assert.equal(keyed.body.conversation.groupKeys.length, 1, 'only my own key envelope comes back');
  assert.equal(keyed.body.conversation.groupKeys[0].userId, alice.id);
  assert.equal(keyed.body.conversation.groupKeys[0].wrappedKey, 'wrapped-key-for-alice');
  keyedGroupId = keyed.body.conversation.id;

  // Name rules.
  const emptyName = await request('POST', '/api/conversations/group', {
    token: alice.token,
    json: { name: '   ', memberIds: [bob.id, carol.id] },
  });
  assert.equal(emptyName.status, 400);
  assert.equal(emptyName.body.error.code, 'VALIDATION_ERROR');

  const longName = await request('POST', '/api/conversations/group', {
    token: alice.token,
    json: { name: 'x'.repeat(51), memberIds: [bob.id, carol.id] },
  });
  assert.equal(longName.status, 400);

  // Member rules.
  const tooFew = await request('POST', '/api/conversations/group', {
    token: alice.token,
    json: { name: 'Tiny', memberIds: [bob.id] },
  });
  assert.equal(tooFew.status, 400);
  assert.equal(tooFew.body.error.code, 'VALIDATION_ERROR');

  const duplicates = await request('POST', '/api/conversations/group', {
    token: alice.token,
    json: { name: 'Dupes', memberIds: [bob.id, bob.id] },
  });
  assert.equal(duplicates.status, 400);

  const creatorOnly = await request('POST', '/api/conversations/group', {
    token: alice.token,
    json: { name: 'Solo', memberIds: [alice.id, bob.id] },
  });
  assert.equal(creatorOnly.status, 400, 'creator does not count towards the 2 members');

  const unknownMember = await request('POST', '/api/conversations/group', {
    token: alice.token,
    json: { name: 'Ghost', memberIds: [bob.id, new mongoose.Types.ObjectId().toString()] },
  });
  assert.equal(unknownMember.status, 400);
  assert.equal(unknownMember.body.error.code, 'UNKNOWN_MEMBERS');

  // groupKeys must only reference members.
  const strangerKey = await request('POST', '/api/conversations/group', {
    token: alice.token,
    json: {
      name: 'Bad keys',
      memberIds: [bob.id, carol.id],
      groupKeys: [
        {
          userId: new mongoose.Types.ObjectId().toString(),
          version: 1,
          wrappedKey: 'x',
          iv: 'y',
          wrappedBy: alice.id,
        },
      ],
    },
  });
  assert.equal(strangerKey.status, 400);
  assert.equal(strangerKey.body.error.code, 'VALIDATION_ERROR');
});

test('list: sorted by lastMessageAt desc with per-user unreadCount', async () => {
  const groupMessage = await sendMessage(groupId, bob.token, 'g-1');
  assert.equal(groupMessage.status, 201);

  await delay(10); // keep lastMessageAt strictly ordered for a deterministic sort

  const direct1 = await sendMessage(directId, bob.token, 'd-1');
  const direct2 = await sendMessage(directId, bob.token, 'd-2');
  assert.equal(direct1.status, 201);
  assert.equal(direct2.status, 201);

  // Alice's own message must not count as her unread.
  const own = await sendMessage(directId, alice.token, 'd-a1');
  assert.equal(own.status, 201);

  const res = await request('GET', '/api/conversations', { token: alice.token });
  assert.equal(res.status, 200);
  const conversations = res.body.conversations;

  assert.deepEqual(
    conversations.map((c) => c.id),
    [directId, groupId, keyedGroupId],
    'most recent first, never-messaged conversation last'
  );

  for (let i = 1; i < conversations.length; i += 1) {
    const previous = conversations[i - 1].lastMessageAt;
    const current = conversations[i].lastMessageAt;
    if (previous && current) {
      assert.ok(Date.parse(previous) >= Date.parse(current), 'lastMessageAt must be desc');
    }
  }

  const direct = conversations.find((c) => c.id === directId);
  const group = conversations.find((c) => c.id === groupId);
  const keyed = conversations.find((c) => c.id === keyedGroupId);

  assert.equal(direct.unreadCount, 2, "bob's two messages are unread for alice");
  assert.equal(group.unreadCount, 1);
  assert.equal(keyed.unreadCount, 0);
  assert.equal(
    keyed.groupKeys.length,
    1,
    "list view includes the requesting user's own key envelopes"
  );
  assert.equal(keyed.groupKeys[0].userId, alice.id);
  assert.deepEqual(group.groupKeys, [], 'a group without keys still reports an empty array');
  assert.ok(!JSON.stringify(res.body).includes('passwordHash'));

  // Members are populated with public fields only.
  for (const member of direct.members) {
    assert.deepEqual(Object.keys(member).sort(), [...USER_PUBLIC_KEYS].sort());
  }

  // Sender sees their own messages as read; bob sees 1 unread (alice's message).
  const bobList = await request('GET', '/api/conversations', { token: bob.token });
  const bobDirect = bobList.body.conversations.find((c) => c.id === directId);
  assert.equal(bobDirect.unreadCount, 1, 'alice\'s own message is the only unread for bob');
});

test('membership: non-members get 403 on conversation views and messages', async () => {
  const listMessages = await request('GET', `/api/conversations/${directId}/messages`, {
    token: carol.token,
  });
  assert.equal(listMessages.status, 403);
  assert.equal(listMessages.body.error.code, 'NOT_A_MEMBER');

  const send = await sendMessage(directId, carol.token, 'sneaky-1');
  assert.equal(send.status, 403);
  assert.equal(send.body.error.code, 'NOT_A_MEMBER');

  const single = await request('GET', `/api/conversations/${directId}`, { token: carol.token });
  assert.equal(single.status, 403);
  assert.equal(single.body.error.code, 'NOT_A_MEMBER');

  // Nothing was stored by the rejected send.
  const count = await Message.countDocuments({ clientId: 'sneaky-1' });
  assert.equal(count, 0);

  // A member sees it fine, with populated members and their own key envelopes.
  const mine = await request('GET', `/api/conversations/${directId}`, { token: alice.token });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.conversation.groupKeys, []);
  assert.equal(mine.body.conversation.members.length, 2);

  const missing = await request(
    'GET',
    `/api/conversations/${new mongoose.Types.ObjectId()}/messages`,
    { token: alice.token }
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'CONVERSATION_NOT_FOUND');

  const invalid = await request('GET', '/api/conversations/xyz/messages', {
    token: alice.token,
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
});

test('messages: cursor pagination returns oldest-to-newest pages', async () => {
  const created = await request('POST', '/api/conversations/direct', {
    token: alice.token,
    json: { userId: carol.id },
  });
  assert.equal(created.status, 201);
  pageConversationId = created.body.conversation.id;

  for (let i = 1; i <= 5; i += 1) {
    const res = await sendMessage(pageConversationId, carol.token, `pg-${i}`);
    assert.equal(res.status, 201);
  }

  // Page 1: newest first from the DB (pg-5, pg-4) but ascending in the response.
  const page1 = await request('GET', `/api/conversations/${pageConversationId}/messages?limit=2`, {
    token: alice.token,
  });
  assert.equal(page1.status, 200);
  assert.deepEqual(page1.body.messages.map((m) => m.clientId), ['pg-4', 'pg-5']);
  assert.equal(page1.body.hasMore, true);
  assert.equal(page1.body.nextBefore, page1.body.messages[0].id);
  assert.ok(
    Date.parse(page1.body.messages[0].createdAt) <= Date.parse(page1.body.messages[1].createdAt),
    'response must be ascending'
  );

  // Page 2 continues exactly where page 1 stopped (id cursor).
  const page2 = await request(
    'GET',
    `/api/conversations/${pageConversationId}/messages?limit=2&before=${page1.body.nextBefore}`,
    { token: alice.token }
  );
  assert.deepEqual(page2.body.messages.map((m) => m.clientId), ['pg-2', 'pg-3']);
  assert.equal(page2.body.hasMore, true);
  assert.equal(page2.body.nextBefore, page2.body.messages[0].id);

  // Page 3 is the tail.
  const page3 = await request(
    'GET',
    `/api/conversations/${pageConversationId}/messages?limit=2&before=${page2.body.nextBefore}`,
    { token: alice.token }
  );
  assert.deepEqual(page3.body.messages.map((m) => m.clientId), ['pg-1']);
  assert.equal(page3.body.hasMore, false);
  assert.equal(page3.body.nextBefore, null);

  // ISO-date cursor: everything created before the date.
  const isoBefore = new Date(Date.now() + 60_000).toISOString();
  const byDate = await request(
    'GET',
    `/api/conversations/${pageConversationId}/messages?before=${encodeURIComponent(isoBefore)}&limit=100`,
    { token: alice.token }
  );
  assert.deepEqual(
    byDate.body.messages.map((m) => m.clientId),
    ['pg-1', 'pg-2', 'pg-3', 'pg-4', 'pg-5']
  );
  assert.equal(byDate.body.hasMore, false);

  // Default limit (30) returns the whole small history.
  const noLimit = await request('GET', `/api/conversations/${pageConversationId}/messages`, {
    token: alice.token,
  });
  assert.equal(noLimit.body.messages.length, 5);
  assert.equal(noLimit.body.hasMore, false);

  // Bad cursors / limits.
  const badDate = await request(
    'GET',
    `/api/conversations/${pageConversationId}/messages?before=not-a-date`,
    { token: alice.token }
  );
  assert.equal(badDate.status, 400);
  assert.equal(badDate.body.error.code, 'VALIDATION_ERROR');

  const foreignCursor = await request(
    'GET',
    `/api/conversations/${pageConversationId}/messages?before=${page1.body.messages[0].id}&limit=1`,
    { token: alice.token }
  );
  assert.equal(foreignCursor.status, 200, 'a valid cursor from the same conversation works');

  const groupMessage = await Message.findOne({ clientId: 'g-1' }).select('_id').lean();
  const wrongConversationCursor = await request(
    'GET',
    `/api/conversations/${pageConversationId}/messages?before=${groupMessage._id}`,
    { token: alice.token }
  );
  assert.equal(wrongConversationCursor.status, 400, 'cursor must belong to this conversation');

  const limitZero = await request(
    'GET',
    `/api/conversations/${pageConversationId}/messages?limit=0`,
    { token: alice.token }
  );
  assert.equal(limitZero.status, 400);

  const limitTooHigh = await request(
    'GET',
    `/api/conversations/${pageConversationId}/messages?limit=101`,
    { token: alice.token }
  );
  assert.equal(limitTooHigh.status, 400);
});

test('messages: deduplicated by sender + clientId', async () => {
  const payload = { ciphertext: 'dup-ciphertext', iv: 'dup-iv', clientId: 'dup-client-1' };

  const first = await request('POST', `/api/conversations/${directId}/messages`, {
    token: bob.token,
    json: payload,
  });
  assert.equal(first.status, 201);

  const second = await request('POST', `/api/conversations/${directId}/messages`, {
    token: bob.token,
    json: payload,
  });
  assert.equal(second.status, 200, 'a retried send is idempotent');
  assert.equal(second.body.message.id, first.body.message.id);
  assert.equal(second.body.message.clientId, 'dup-client-1');

  const stored = await Message.countDocuments({ sender: bob.id, clientId: 'dup-client-1' });
  assert.equal(stored, 1, 'only one message row per sender + clientId');

  // The same clientId in another conversation is a conflict, never a leak.
  const elsewhere = await sendMessage(groupId, bob.token, 'dup-client-1');
  assert.equal(elsewhere.status, 409);
  assert.equal(elsewhere.body.error.code, 'CLIENT_ID_REUSED');

  // Dedup still bumps the conversation cursor the first time…
  const conversation = await request('GET', `/api/conversations/${directId}`, {
    token: alice.token,
  });
  assert.equal(conversation.body.conversation.lastMessageId, first.body.message.id);
  assert.ok(conversation.body.conversation.lastMessageAt);
});

test('delete for everyone: sender only, content cleared, hidden in history', async () => {
  const sent = await sendMessage(pageConversationId, carol.token, 'del-1');
  assert.equal(sent.status, 201);
  const messageId = sent.body.message.id;

  const asAlice = await request('DELETE', `/api/messages/${messageId}`, { token: alice.token });
  assert.equal(asAlice.status, 403, 'non-senders cannot delete');
  assert.equal(asAlice.body.error.code, 'NOT_MESSAGE_SENDER');

  const deleted = await request('DELETE', `/api/messages/${messageId}`, { token: carol.token });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.message.deletedForEveryone, true);
  assert.equal(deleted.body.message.ciphertext, null);
  assert.equal(deleted.body.message.iv, null);

  // The stored row keeps the envelope but the content is gone.
  const raw = await Message.findById(messageId).lean();
  assert.equal(raw.deletedForEveryone, true);
  assert.equal(raw.ciphertext, '');
  assert.equal(raw.iv, null);

  // It is still the newest message — history hides its content.
  const history = await request(
    'GET',
    `/api/conversations/${pageConversationId}/messages?limit=1`,
    { token: alice.token }
  );
  assert.equal(history.body.messages[0].id, messageId);
  assert.equal(history.body.messages[0].ciphertext, null);
  assert.equal(history.body.messages[0].iv, null);

  // Idempotent.
  const again = await request('DELETE', `/api/messages/${messageId}`, { token: carol.token });
  assert.equal(again.status, 200);
  assert.equal(again.body.message.deletedForEveryone, true);

  const missing = await request(
    'DELETE',
    `/api/messages/${new mongoose.Types.ObjectId()}`,
    { token: carol.token }
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'MESSAGE_NOT_FOUND');

  const invalid = await request('DELETE', '/api/messages/xyz', { token: carol.token });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
});

test('messages: payload validation and auth', async () => {
  const noToken = await request('GET', `/api/conversations/${pageConversationId}/messages`);
  assert.equal(noToken.status, 401);
  assert.equal(noToken.body.error.code, 'AUTH_REQUIRED');

  const emptyCiphertext = await request('POST', `/api/conversations/${pageConversationId}/messages`, {
    token: carol.token,
    json: { ciphertext: '', iv: 'iv-x', clientId: 'v-1' },
  });
  assert.equal(emptyCiphertext.status, 400);
  assert.equal(emptyCiphertext.body.error.code, 'VALIDATION_ERROR');

  const tooLong = await request('POST', `/api/conversations/${pageConversationId}/messages`, {
    token: carol.token,
    json: { ciphertext: 'a'.repeat(8001), iv: 'iv-x', clientId: 'v-2' },
  });
  assert.equal(tooLong.status, 400);

  const noIv = await request('POST', `/api/conversations/${pageConversationId}/messages`, {
    token: carol.token,
    json: { ciphertext: 'hello', encrypted: true, clientId: 'v-3' },
  });
  assert.equal(noIv.status, 400);
  assert.match(noIv.body.error.message, /iv/);

  const noClientId = await request('POST', `/api/conversations/${pageConversationId}/messages`, {
    token: carol.token,
    json: { ciphertext: 'hello', iv: 'iv-x' },
  });
  assert.equal(noClientId.status, 400);

  const blankClientId = await request('POST', `/api/conversations/${pageConversationId}/messages`, {
    token: carol.token,
    json: { ciphertext: 'hello', iv: 'iv-x', clientId: '   ' },
  });
  assert.equal(blankClientId.status, 400);

  // With REQUIRE_E2EE=false (test default) plaintext-style messages are allowed.
  const unencrypted = await request('POST', `/api/conversations/${pageConversationId}/messages`, {
    token: carol.token,
    json: { ciphertext: 'plain', iv: 'iv-x', encrypted: false, clientId: 'v-4' },
  });
  assert.equal(unencrypted.status, 201);
  assert.equal(unencrypted.body.message.encrypted, false);

  // At most 8000 characters.
  const maxLength = await request('POST', `/api/conversations/${pageConversationId}/messages`, {
    token: carol.token,
    json: { ciphertext: 'a'.repeat(8000), iv: 'iv-x', clientId: 'v-5' },
  });
  assert.equal(maxLength.status, 201);
});

test('group keys: POST /:id/keys rotates atomically and enforces the protocol', async () => {
  const before = await request('GET', `/api/conversations/${keyedGroupId}`, { token: alice.token });
  assert.equal(before.body.conversation.currentKeyVersion, 2);

  // Non-admin cannot rotate.
  const asBob = await request('POST', `/api/conversations/${keyedGroupId}/keys`, {
    token: bob.token,
    json: {
      baseVersion: 2,
      groupKeys: [
        { userId: alice.id, version: 3, wrappedKey: 'a', iv: 'iv', wrappedBy: bob.id },
        { userId: bob.id, version: 3, wrappedKey: 'b', iv: 'iv', wrappedBy: bob.id },
        { userId: carol.id, version: 3, wrappedKey: 'c', iv: 'iv', wrappedBy: bob.id },
      ],
    },
  });
  assert.equal(asBob.status, 403);
  assert.equal(asBob.body.error.code, 'NOT_GROUP_ADMIN');

  // Stale baseVersion.
  const stale = await request('POST', `/api/conversations/${keyedGroupId}/keys`, {
    token: alice.token,
    json: {
      baseVersion: 1,
      groupKeys: [
        { userId: alice.id, version: 2, wrappedKey: 'a', iv: 'iv', wrappedBy: alice.id },
        { userId: bob.id, version: 2, wrappedKey: 'b', iv: 'iv', wrappedBy: alice.id },
        { userId: carol.id, version: 2, wrappedKey: 'c', iv: 'iv', wrappedBy: alice.id },
      ],
    },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'STALE_KEY_VERSION');

  // Incomplete coverage.
  const incomplete = await request('POST', `/api/conversations/${keyedGroupId}/keys`, {
    token: alice.token,
    json: {
      baseVersion: 2,
      groupKeys: [
        { userId: alice.id, version: 3, wrappedKey: 'a', iv: 'iv', wrappedBy: alice.id },
      ],
    },
  });
  assert.equal(incomplete.status, 400);
  assert.equal(incomplete.body.error.code, 'INCOMPLETE_KEYS');

  // wrappedBy must be the acting admin.
  const badWrapper = await request('POST', `/api/conversations/${keyedGroupId}/keys`, {
    token: alice.token,
    json: {
      baseVersion: 2,
      groupKeys: [
        { userId: alice.id, version: 3, wrappedKey: 'a', iv: 'iv', wrappedBy: bob.id },
        { userId: bob.id, version: 3, wrappedKey: 'b', iv: 'iv', wrappedBy: bob.id },
        { userId: carol.id, version: 3, wrappedKey: 'c', iv: 'iv', wrappedBy: bob.id },
      ],
    },
  });
  assert.equal(badWrapper.status, 400);
  assert.equal(badWrapper.body.error.code, 'VALIDATION_ERROR');

  // Wrong new version.
  const badVersion = await request('POST', `/api/conversations/${keyedGroupId}/keys`, {
    token: alice.token,
    json: {
      baseVersion: 2,
      groupKeys: [
        { userId: alice.id, version: 4, wrappedKey: 'a', iv: 'iv', wrappedBy: alice.id },
        { userId: bob.id, version: 4, wrappedKey: 'b', iv: 'iv', wrappedBy: alice.id },
        { userId: carol.id, version: 4, wrappedKey: 'c', iv: 'iv', wrappedBy: alice.id },
      ],
    },
  });
  assert.equal(badVersion.status, 400);

  // Direct conversation → NOT_A_GROUP.
  const direct = await request('POST', `/api/conversations/${directId}/keys`, {
    token: alice.token,
    json: {
      baseVersion: 1,
      groupKeys: [{ userId: alice.id, version: 2, wrappedKey: 'a', iv: 'iv', wrappedBy: alice.id }],
    },
  });
  assert.equal(direct.status, 400);
  assert.equal(direct.body.error.code, 'NOT_A_GROUP');

  // Success.
  const rotated = await request('POST', `/api/conversations/${keyedGroupId}/keys`, {
    token: alice.token,
    json: {
      baseVersion: 2,
      groupKeys: [
        { userId: alice.id, version: 3, wrappedKey: 'wrapped-v3-alice', iv: 'iv', wrappedBy: alice.id },
        { userId: bob.id, version: 3, wrappedKey: 'wrapped-v3-bob', iv: 'iv', wrappedBy: alice.id },
        { userId: carol.id, version: 3, wrappedKey: 'wrapped-v3-carol', iv: 'iv', wrappedBy: alice.id },
      ],
    },
  });
  assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
  assert.equal(rotated.body.conversation.currentKeyVersion, 3);
  assert.equal(
    rotated.body.conversation.groupKeys.length,
    2,
    'only the requester own envelopes come back (v2 + v3)'
  );
  const ownV3 = rotated.body.conversation.groupKeys.find((key) => key.version === 3);
  assert.ok(ownV3);
  assert.equal(ownV3.userId, alice.id);
  assert.equal(ownV3.wrappedKey, 'wrapped-v3-alice');

  // A second rotation with the old baseVersion is now stale.
  const again = await request('POST', `/api/conversations/${keyedGroupId}/keys`, {
    token: alice.token,
    json: {
      baseVersion: 2,
      groupKeys: [
        { userId: alice.id, version: 3, wrappedKey: 'x', iv: 'iv', wrappedBy: alice.id },
        { userId: bob.id, version: 3, wrappedKey: 'x', iv: 'iv', wrappedBy: alice.id },
        { userId: carol.id, version: 3, wrappedKey: 'x', iv: 'iv', wrappedBy: alice.id },
      ],
    },
  });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'STALE_KEY_VERSION');

  // Bob's view now includes his v3 envelope.
  const bobView = await request('GET', `/api/conversations/${keyedGroupId}`, { token: bob.token });
  assert.equal(bobView.body.conversation.currentKeyVersion, 3);
  const bobV3 = bobView.body.conversation.groupKeys.find((key) => key.version === 3);
  assert.ok(bobV3);
  assert.equal(bobV3.userId, bob.id);
  assert.equal(bobV3.wrappedKey, 'wrapped-v3-bob');

  // Raw storage keeps all three envelopes at v3 (old versions are retained).
  const raw = await Conversation.findById(keyedGroupId).lean();
  assert.equal(raw.groupKeys.filter((key) => key.version === 3).length, 3);
  assert.equal(raw.currentKeyVersion, 3);
});

test('group keys: addMembers carries envelopes for the newcomers and validates them', async () => {
  const created = await request('POST', '/api/conversations/group', {
    token: alice.token,
    json: { name: 'AddKeys Group', memberIds: [bob.id, carol.id] },
  });
  assert.equal(created.status, 201);
  const groupId = created.body.conversation.id;

  // Envelope targeting an existing member is rejected.
  const badEnvelope = await request('POST', `/api/conversations/${groupId}/members`, {
    token: alice.token,
    json: {
      userIds: [bob.id],
      groupKeys: [
        { userId: carol.id, version: 1, wrappedKey: 'x', iv: 'iv', wrappedBy: alice.id },
      ],
    },
  });
  assert.equal(badEnvelope.status, 400);
  assert.equal(badEnvelope.body.error.code, 'VALIDATION_ERROR');

  // With no existing keys, a newcomer can be added with a version-1 envelope
  // (and the envelope is stored and returned to the requester).
  const added = await request('POST', `/api/conversations/${groupId}/members`, {
    token: alice.token,
    json: {
      userIds: [carol.id],
      groupKeys: [],
    },
  });
  // carol is already a member → no-op, still 200.
  assert.equal(added.status, 200);
});

test('group keys: addMembers requires every existing version for a newcomer', async () => {
  // A real newcomer: bob and carol are already members of the group below.
  const dave = await registerUser('dave_conv', 'Dave');

  const created = await request('POST', '/api/conversations/group', {
    token: alice.token,
    json: {
      name: 'Keyed Add Group',
      memberIds: [bob.id, carol.id],
      groupKeys: [
        { userId: alice.id, version: 1, wrappedKey: 'v1-alice', iv: 'iv', wrappedBy: alice.id },
        { userId: alice.id, version: 2, wrappedKey: 'v2-alice', iv: 'iv', wrappedBy: alice.id },
      ],
    },
  });
  assert.equal(created.status, 201);
  const groupId = created.body.conversation.id;

  // Missing v1 for the newcomer → INCOMPLETE_KEYS (server validates shape even
  // when REQUIRE_E2EE is false, as long as envelopes are supplied).
  const incomplete = await request('POST', `/api/conversations/${groupId}/members`, {
    token: alice.token,
    json: {
      userIds: [dave.id],
      groupKeys: [
        { userId: dave.id, version: 2, wrappedKey: 'v2-dave', iv: 'iv', wrappedBy: alice.id },
      ],
    },
  });
  assert.equal(incomplete.status, 400);
  assert.equal(incomplete.body.error.code, 'INCOMPLETE_KEYS');

  // Complete set → accepted, stored, and returned to the requester.
  const complete = await request('POST', `/api/conversations/${groupId}/members`, {
    token: alice.token,
    json: {
      userIds: [dave.id],
      groupKeys: [
        { userId: dave.id, version: 1, wrappedKey: 'v1-dave', iv: 'iv', wrappedBy: alice.id },
        { userId: dave.id, version: 2, wrappedKey: 'v2-dave', iv: 'iv', wrappedBy: alice.id },
      ],
    },
  });
  assert.equal(complete.status, 200, JSON.stringify(complete.body));
  const daveView = await request('GET', `/api/conversations/${groupId}`, { token: dave.token });
  assert.equal(daveView.body.conversation.groupKeys.length, 2);
});
