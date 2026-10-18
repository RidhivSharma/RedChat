// REQUIRE_E2EE=true gate, exercised through the shared messageService.
// process.env must be set before src/config/env.js is imported, so src/ modules
// are loaded dynamically after the assignment below.
import './helpers/setup.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.REQUIRE_E2EE = 'true';

const { default: mongoose } = await import('mongoose');
const { connectDB } = await import('../src/config/db.js');
const { createMessage } = await import('../src/utils/messageService.js');
const { Conversation, Message, User } = await import('../src/models/index.js');
const { dropTestDatabase } = await import('./helpers/harness.js');

let aliceId;
let conversation;

before(async () => {
  await connectDB();
  await dropTestDatabase();

  const [alice, bob] = await User.create([
    { username: 'alice_e2ee', displayName: 'Alice', passwordHash: 'not-used-in-this-test' },
    { username: 'bob_e2ee', displayName: 'Bob', passwordHash: 'not-used-in-this-test' },
  ]);
  aliceId = alice._id;

  conversation = await Conversation.create({
    type: 'direct',
    members: [alice._id, bob._id],
    directKey: [alice._id.toString(), bob._id.toString()].sort().join('_'),
    createdBy: alice._id,
  });
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await dropTestDatabase();
    await mongoose.disconnect();
  }
});

test('createMessage: REQUIRE_E2EE=true rejects unencrypted messages', async () => {
  await assert.rejects(
    () =>
      createMessage({
        conversation,
        senderId: aliceId,
        payload: {
          ciphertext: 'plain text',
          iv: 'iv-1',
          encrypted: false,
          clientId: 'e2ee-plain',
        },
      }),
    (err) => {
      assert.equal(err.code, 'ENCRYPTION_REQUIRED');
      assert.equal(err.statusCode, 400);
      return true;
    }
  );

  const stored = await Message.countDocuments({ clientId: 'e2ee-plain' });
  assert.equal(stored, 0, 'the rejected message must not be stored');
});

test('createMessage: REQUIRE_E2EE=true accepts encrypted messages and stamps the conversation', async () => {
  const { message, deduplicated } = await createMessage({
    conversation,
    senderId: aliceId,
    payload: { ciphertext: 'encrypted-blob', iv: 'iv-2', encrypted: true, clientId: 'e2ee-ok' },
  });

  assert.equal(deduplicated, false);
  assert.equal(message.encrypted, true);
  assert.equal(message.ciphertext, 'encrypted-blob');

  const stored = await Conversation.findById(conversation._id)
    .select('lastMessageAt lastMessageId')
    .lean();
  assert.equal(String(stored.lastMessageId), String(message._id));
  assert.ok(stored.lastMessageAt instanceof Date);

  // Missing iv is rejected even when the flag is on.
  await assert.rejects(
    () =>
      createMessage({
        conversation,
        senderId: aliceId,
        payload: { ciphertext: 'no-iv', encrypted: true, clientId: 'e2ee-no-iv' },
      }),
    (err) => err.code === 'VALIDATION_ERROR'
  );
});
