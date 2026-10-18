import { Conversation, Message, User } from '../models/index.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  OBJECT_ID_RE,
  assertGroupAdmin,
  assertGroupConversation,
  loadConversationForMember,
} from '../utils/conversationAccess.js';
import { buildDirectKey } from '../utils/directKey.js';
import {
  createMessage,
  createSystemMessage,
  unreadMessagesFilter,
} from '../utils/messageService.js';
import {
  MEMBER_FIELDS,
  MESSAGE_FIELDS,
  serializeConversation,
  serializeMessage,
} from '../utils/serialize.js';
import {
  announceConversationCreated,
  announceConversationKeys,
  announceConversationRemoved,
  announceConversationToMember,
  announceConversationUpdated,
  announceKeyRotationRequested,
  announceNewMessage,
  announcePresenceForNewMembers,
} from '../sockets/conversations.js';

const MAX_GROUP_MEMBERS = 50;
const MIN_GROUP_MEMBERS = 2;

/**
 * Unread = messages from others in this conversation that are not in readBy
 * for this user (deleted-for-everyone messages do not count). The filter is
 * shared with the read-receipt writes so the count can never drift.
 */
function countUnreadMessages(conversationId, userId) {
  return Message.countDocuments(unreadMessagesFilter(userId, { conversationId }));
}

/** Reloads a conversation with populated members (the response/emit shape). */
function loadPopulatedConversation(conversationId) {
  return Conversation.findById(conversationId).populate('members', MEMBER_FIELDS).lean();
}

/**
 * Fetches the newest message of each conversation (one query for the whole
 * list). The client decrypts previews locally — the server only relays the
 * stored ciphertext envelope.
 */
async function loadLastMessages(conversations) {
  const ids = conversations.map((conversation) => conversation.lastMessageId).filter(Boolean);
  if (ids.length === 0) return new Map();

  const rows = await Message.find({ _id: { $in: ids } }).select(MESSAGE_FIELDS).lean();
  return new Map(rows.map((row) => [row._id.toString(), row]));
}

/** The serialized last message for one conversation, if any. */
async function loadLastMessage(conversation) {
  if (!conversation?.lastMessageId) return null;
  return Message.findById(conversation.lastMessageId).select(MESSAGE_FIELDS).lean();
}

function displayNameOf(user) {
  return user?.displayName || user?.username || 'Someone';
}

/** Display name of a member of a populated conversation. */
function memberName(populatedConversation, userId) {
  const target = userId.toString();
  const member = (populatedConversation.members ?? []).find(
    (entry) => (entry._id ?? entry).toString() === target
  );
  return displayNameOf(member);
}

/** Shared response for every explicit group mutation: { conversation }. */
async function respondWithConversation(res, conversationId, viewerId) {
  const populated = await loadPopulatedConversation(conversationId);
  const unreadCount = await countUnreadMessages(conversationId, viewerId);
  const lastMessage = await loadLastMessage(populated);
  res.json({
    conversation: serializeConversation(populated, {
      unreadCount,
      groupKeysFor: viewerId,
      lastMessage,
    }),
  });
}

/**
 * POST /api/conversations/direct { userId }
 * Finds or creates the direct conversation with that user via the unique
 * directKey (idempotent — both members get the same conversation).
 */
export const createDirectConversation = asyncHandler(async (req, res) => {
  const { userId } = req.body; // zod-validated
  const selfId = req.user._id.toString();

  if (userId.toLowerCase() === selfId) {
    throw AppError.badRequest(
      'You cannot start a conversation with yourself',
      'SELF_CONVERSATION'
    );
  }

  const other = await User.findById(userId).select('_id').lean();
  if (!other) {
    throw new AppError('User not found', 404, 'USER_NOT_FOUND');
  }

  const directKey = buildDirectKey(selfId, other._id);

  let conversation = await Conversation.findOne({ directKey })
    .populate('members', MEMBER_FIELDS)
    .lean();
  let created = false;

  if (!conversation) {
    try {
      const doc = await Conversation.create({
        type: 'direct',
        members: [req.user._id, other._id],
        directKey,
        createdBy: req.user._id,
      });
      await doc.populate('members', MEMBER_FIELDS);
      conversation = doc;
      created = true;
    } catch (err) {
      // Unique directKey race: a concurrent request created it first.
      if (err?.code !== 11000) throw err;
      conversation = await Conversation.findOne({ directKey })
        .populate('members', MEMBER_FIELDS)
        .lean();
    }
  }

  // Let the members' sockets join the room and learn about the conversation.
  if (created) {
    announceConversationCreated(conversation);
  }

  const unreadCount = await countUnreadMessages(conversation._id, req.user._id);
  res.status(created ? 201 : 200).json({
    conversation: serializeConversation(conversation, {
      unreadCount,
      groupKeysFor: req.user._id,
      lastMessage: null,
    }),
  });
});

/**
 * POST /api/conversations/group { name, memberIds, groupKeys? }
 * Creates a group with the creator as admin. groupKeys is optional for now
 * and is consumed by the encryption phase.
 */
export const createGroupConversation = asyncHandler(async (req, res) => {
  const { name, memberIds, groupKeys } = req.body; // zod-validated
  const creatorId = req.user._id;
  const creatorKey = creatorId.toString();

  // 2-50 members besides the creator. The creator may be (redundantly) listed.
  const uniqueMemberIds = [...new Set(memberIds.map((id) => id.toLowerCase()))].filter(
    (id) => id !== creatorKey
  );
  if (uniqueMemberIds.length < MIN_GROUP_MEMBERS) {
    throw AppError.badRequest(
      `A group needs at least ${MIN_GROUP_MEMBERS} members besides the creator`,
      'VALIDATION_ERROR'
    );
  }
  if (uniqueMemberIds.length > MAX_GROUP_MEMBERS) {
    throw AppError.badRequest(
      `A group can have at most ${MAX_GROUP_MEMBERS} members besides the creator`,
      'VALIDATION_ERROR'
    );
  }

  const found = await User.find({ _id: { $in: uniqueMemberIds } }).select('_id').lean();
  if (found.length !== uniqueMemberIds.length) {
    const foundIds = new Set(found.map((user) => user._id.toString()));
    const missing = uniqueMemberIds.filter((id) => !foundIds.has(id));
    throw AppError.badRequest(`Unknown memberIds: ${missing.join(', ')}`, 'UNKNOWN_MEMBERS');
  }

  const members = [creatorId, ...uniqueMemberIds];
  const memberStrings = new Set(members.map((id) => id.toString()));

  // Group key envelopes may only target members of this group.
  for (const key of groupKeys) {
    if (
      !memberStrings.has(key.userId.toLowerCase()) ||
      !memberStrings.has(key.wrappedBy.toLowerCase())
    ) {
      throw AppError.badRequest(
        'groupKeys entries must reference conversation members',
        'VALIDATION_ERROR'
      );
    }
  }

  const currentKeyVersion =
    groupKeys.length > 0 ? Math.max(...groupKeys.map((key) => key.version)) : 1;

  const conversation = await Conversation.create({
    type: 'group',
    name,
    members,
    admins: [creatorId],
    createdBy: creatorId,
    groupKeys,
    currentKeyVersion,
  });
  await conversation.populate('members', MEMBER_FIELDS);
  announceConversationCreated(conversation);

  res.status(201).json({
    conversation: serializeConversation(conversation, {
      groupKeysFor: creatorId,
      lastMessage: null,
    }),
  });
});

/**
 * GET /api/conversations
 * Sorted by lastMessageAt desc, members populated, unreadCount per
 * conversation (messages from others not yet in readBy for this user).
 * Each conversation also carries the requesting user's own key envelopes (the
 * client needs them to decrypt group history/previews) and the last message
 * envelope (the client decrypts its preview locally).
 */
export const listConversations = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const conversations = await Conversation.find({ members: userId })
    .sort({ lastMessageAt: -1, createdAt: -1 })
    .populate('members', MEMBER_FIELDS)
    .lean();

  const unreadByConversation = new Map();
  if (conversations.length > 0) {
    const rows = await Message.aggregate([
      {
        $match: unreadMessagesFilter(userId, {
          conversationId: { $in: conversations.map((conversation) => conversation._id) },
        }),
      },
      { $group: { _id: '$conversationId', count: { $sum: 1 } } },
    ]);
    for (const row of rows) {
      unreadByConversation.set(row._id.toString(), row.count);
    }
  }

  const lastMessages = await loadLastMessages(conversations);

  res.json({
    conversations: conversations.map((conversation) =>
      serializeConversation(conversation, {
        unreadCount: unreadByConversation.get(conversation._id.toString()) ?? 0,
        groupKeysFor: userId,
        lastMessage: conversation.lastMessageId
          ? lastMessages.get(conversation.lastMessageId.toString()) ?? null
          : null,
      })
    ),
  });
});

/** GET /api/conversations/:id — members only. */
export const getConversation = asyncHandler(async (req, res) => {
  const conversation = await loadConversationForMember(req.params.id, req.user._id, {
    populateMembers: true,
  });

  const unreadCount = await countUnreadMessages(conversation._id, req.user._id);
  const lastMessage = await loadLastMessage(conversation);

  res.json({
    conversation: serializeConversation(conversation, {
      unreadCount,
      groupKeysFor: req.user._id,
      lastMessage,
    }),
  });
});

/**
 * Resolves the ?before cursor: either a message id (exact cursor, with an
 * _id tiebreaker for same-millisecond messages) or an ISO date.
 */
async function resolveMessageCursor(before, conversationId) {
  if (OBJECT_ID_RE.test(before)) {
    const cursor = await Message.findById(before).select('createdAt conversationId').lean();
    if (!cursor || cursor.conversationId.toString() !== conversationId.toString()) {
      throw AppError.badRequest('Invalid "before" cursor', 'VALIDATION_ERROR');
    }
    return { createdAt: cursor.createdAt, id: cursor._id };
  }

  const date = new Date(before);
  if (Number.isNaN(date.getTime())) {
    throw AppError.badRequest('"before" must be an ISO date or a message id', 'VALIDATION_ERROR');
  }
  return { createdAt: date, id: null };
}

/**
 * GET /api/conversations/:id/messages?before=&limit=
 * Cursor pagination: newest first from the database, returned oldest → newest.
 * Contents of deletedForEveryone messages are hidden.
 */
export const listMessages = asyncHandler(async (req, res) => {
  const conversation = await loadConversationForMember(req.params.id, req.user._id);
  const { before, limit } = req.validatedQuery;

  const filter = { conversationId: conversation._id };

  if (before) {
    const cursor = await resolveMessageCursor(before, conversation._id);
    if (cursor.id) {
      filter.$or = [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
      ];
    } else {
      filter.createdAt = { $lt: cursor.createdAt };
    }
  }

  // Fetch one extra row to know whether another page exists.
  const rows = await Message.find(filter)
    .select(MESSAGE_FIELDS)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  page.reverse(); // response order: oldest → newest

  res.json({
    messages: page.map(serializeMessage),
    hasMore,
    // The oldest returned message is the cursor for the next page.
    nextBefore: hasMore ? page[0]._id.toString() : null,
  });
});

/**
 * POST /api/conversations/:id/messages
 * REST fallback (mainly for testing) — the Socket.io layer reuses the same
 * createMessage() service next phase.
 */
export const postMessage = asyncHandler(async (req, res) => {
  const conversation = await loadConversationForMember(req.params.id, req.user._id);

  const { message, deduplicated } = await createMessage({
    conversation,
    senderId: req.user._id,
    payload: req.body, // zod-validated
  });

  res.status(deduplicated ? 200 : 201).json({ message: serializeMessage(message) });
});

// ---------------------------------------------------------------------------
// Group management — every handler below checks "is a group" and "is an admin"
// (except leaving yourself), keeps the admin invariant and records a plain
// system message so the timeline explains what happened.
// ---------------------------------------------------------------------------

/**
 * POST /api/conversations/:id/members { userIds, groupKeys? } — group admins
 * only. Existing members receive "conversation:updated", every newly added
 * member's sockets join the room and receive "conversation:new", and a system
 * message ("Alex added Sam") is stored and broadcast to the room.
 *
 * `groupKeys` are the newcomers' key envelopes (every version the group has,
 * wrapped by the acting admin). The server cannot verify the cryptography, but
 * it does enforce the shape: envelopes may only target the newly added members,
 * only the acting admin may be `wrappedBy`, no future versions, and (while
 * REQUIRE_E2EE is on) every version that exists in the group must be wrapped
 * for every newcomer — otherwise the newcomer would be unable to read new
 * messages.
 */
export const addGroupMembers = asyncHandler(async (req, res) => {
  const actorId = req.user._id;
  const actorKey = actorId.toString();
  const conversation = await loadConversationForMember(req.params.id, actorId);
  assertGroupAdmin(conversation, actorId);

  const existing = new Set(conversation.members.map((id) => id.toString()));
  const newIds = [...new Set(req.body.userIds.map((id) => id.toLowerCase()))].filter(
    (id) => !existing.has(id)
  );

  const currentVersion = conversation.currentKeyVersion ?? 1;

  // Versions that already exist for this group (from any member's envelopes).
  const existingVersions = [
    ...new Set((conversation.groupKeys ?? []).map((key) => key.version)),
  ].sort((a, b) => a - b);

  // Validate the supplied envelopes before touching the database.
  const cleanKeys = [];
  for (const key of req.body.groupKeys ?? []) {
    const keyUserId = key.userId.toLowerCase();
    if (!newIds.includes(keyUserId)) {
      throw AppError.badRequest(
        'groupKeys entries must target the newly added members',
        'VALIDATION_ERROR'
      );
    }
    if (key.wrappedBy.toLowerCase() !== actorKey) {
      throw AppError.badRequest(
        'groupKeys wrappedBy must be the acting admin',
        'VALIDATION_ERROR'
      );
    }
    if (key.version > currentVersion) {
      throw AppError.badRequest(
        'groupKeys entries cannot use a future key version',
        'VALIDATION_ERROR'
      );
    }
    cleanKeys.push({
      userId: keyUserId,
      version: key.version,
      wrappedKey: key.wrappedKey,
      iv: key.iv,
      wrappedBy: actorKey,
    });
  }

  // Every newcomer must receive an envelope for every existing key version,
  // otherwise they would see "cannot decrypt" for messages they should read.
  if ((cleanKeys.length > 0 || env.REQUIRE_E2EE) && existingVersions.length > 0) {
    const wrappedByMember = new Map();
    for (const key of cleanKeys) {
      if (!wrappedByMember.has(key.userId)) wrappedByMember.set(key.userId, new Set());
      wrappedByMember.get(key.userId).add(key.version);
    }
    for (const memberId of newIds) {
      const versions = wrappedByMember.get(memberId) ?? new Set();
      const missing = existingVersions.filter((version) => !versions.has(version));
      if (missing.length > 0) {
        throw AppError.badRequest(
          `groupKeys must wrap every existing key version for each new member (missing: ${missing.join(', ')})`,
          'INCOMPLETE_KEYS'
        );
      }
    }
  }

  // Everyone is already a member: no-op, no system message.
  if (newIds.length === 0) {
    await respondWithConversation(res, conversation._id, actorId);
    return;
  }

  // Mirrors the create-group cap: at most 50 members besides the creator.
  if (existing.size + newIds.length > MAX_GROUP_MEMBERS + 1) {
    throw AppError.badRequest(
      `A group can have at most ${MAX_GROUP_MEMBERS} members besides the creator`,
      'GROUP_FULL'
    );
  }

  const users = await User.find({ _id: { $in: newIds } }).select('_id').lean();
  if (users.length !== newIds.length) {
    const foundIds = new Set(users.map((user) => user._id.toString()));
    const missing = newIds.filter((id) => !foundIds.has(id));
    throw AppError.badRequest(`Unknown userIds: ${missing.join(', ')}`, 'UNKNOWN_MEMBERS');
  }

  await Conversation.updateOne(
    { _id: conversation._id },
    {
      $push: {
        members: { $each: newIds },
        groupKeys: { $each: cleanKeys },
      },
    }
  );

  const populated = await loadPopulatedConversation(conversation._id);

  // Existing members first (the newcomers are not in the room yet), so the
  // newcomers only ever see "conversation:new" for this change.
  announceConversationUpdated(populated);

  const systemMessage = await createSystemMessage({
    conversationId: conversation._id,
    senderId: actorId,
    text: `${displayNameOf(req.user)} added ${newIds
      .map((id) => memberName(populated, id))
      .join(', ')}`,
  });

  for (const memberId of newIds) {
    announceConversationToMember(populated, memberId);
  }
  announcePresenceForNewMembers(populated, newIds);
  announceNewMessage(systemMessage);

  await respondWithConversation(res, conversation._id, actorId);
});

/**
 * DELETE /api/conversations/:id/members/:userId
 * An admin removes a member; anybody may remove themselves (leave the group).
 * A group always keeps at least one admin: when the last admin leaves, the
 * earliest remaining member (member order = join order) is promoted. The
 * removed member's sockets leave the room and receive "conversation:removed";
 * when the last member leaves, the empty group is deleted.
 */
export const removeGroupMember = asyncHandler(async (req, res) => {
  const actorId = req.user._id;
  const actorKey = actorId.toString();
  const targetKey = String(req.params.userId ?? '').toLowerCase();

  if (!OBJECT_ID_RE.test(targetKey)) {
    throw AppError.badRequest('Invalid user id', 'VALIDATION_ERROR');
  }

  const conversation = await loadConversationForMember(req.params.id, actorId);
  assertGroupConversation(conversation);

  const self = targetKey === actorKey;
  if (!self) assertGroupAdmin(conversation, actorId);

  const memberIds = conversation.members.map((id) => id.toString());
  if (!memberIds.includes(targetKey)) {
    throw new AppError('That user is not a member of this group', 404, 'MEMBER_NOT_FOUND');
  }

  const remainingMembers = memberIds.filter((id) => id !== targetKey);
  const remainingAdmins = (conversation.admins ?? [])
    .map((id) => id.toString())
    .filter((id) => id !== targetKey);

  const promotedId =
    remainingMembers.length > 0 && remainingAdmins.length === 0 ? remainingMembers[0] : null;
  if (promotedId) remainingAdmins.push(promotedId);

  // The last member left: nobody can reach the group anymore.
  if (remainingMembers.length === 0) {
    await Conversation.deleteOne({ _id: conversation._id });
    await Message.deleteMany({ conversationId: conversation._id });
    announceConversationRemoved(conversation._id, targetKey, { left: self });
    res.json({ conversationId: conversation._id.toString(), left: self });
    return;
  }

  const targetName = self
    ? displayNameOf(req.user)
    : displayNameOf(await User.findById(targetKey).select('displayName username').lean());

  await Conversation.updateOne(
    { _id: conversation._id },
    { $set: { members: remainingMembers, admins: remainingAdmins } }
  );

  const populated = await loadPopulatedConversation(conversation._id);

  // The removed member's sockets leave the room before the room is notified.
  announceConversationRemoved(conversation._id, targetKey, { left: self });
  announceConversationUpdated(populated);

  announceNewMessage(
    await createSystemMessage({
      conversationId: conversation._id,
      senderId: actorId,
      text: self ? `${targetName} left` : `${displayNameOf(req.user)} removed ${targetName}`,
    })
  );

  if (promotedId) {
    announceNewMessage(
      await createSystemMessage({
        conversationId: conversation._id,
        senderId: actorId,
        text: `${memberName(populated, promotedId)} is now an admin`,
      })
    );
  }

  // The removed member must not decrypt anything sent from now on: ask the
  // remaining admins to rotate the group key (wrap the next version for the
  // current members and POST it to /keys). Only relevant once encryption is
  // actually in use for this group.
  if ((conversation.groupKeys ?? []).length > 0 || env.REQUIRE_E2EE) {
    announceKeyRotationRequested(conversation, remainingAdmins, {
      removedUserId: targetKey,
    });
  }

  if (self) {
    res.json({ conversationId: conversation._id.toString(), left: true });
  } else {
    await respondWithConversation(res, conversation._id, actorId);
  }
});

/** PATCH /api/conversations/:id { name } — group admins only. */
export const renameConversation = asyncHandler(async (req, res) => {
  const actorId = req.user._id;
  const conversation = await loadConversationForMember(req.params.id, actorId);
  assertGroupAdmin(conversation, actorId);

  const { name } = req.body; // zod-validated (trimmed, 1-50 chars)

  if ((conversation.name ?? '') !== name) {
    await Conversation.updateOne({ _id: conversation._id }, { $set: { name } });

    const populated = await loadPopulatedConversation(conversation._id);
    announceConversationUpdated(populated);
    announceNewMessage(
      await createSystemMessage({
        conversationId: conversation._id,
        senderId: actorId,
        text: `${displayNameOf(req.user)} renamed the group to “${name}”`,
      })
    );
  }

  await respondWithConversation(res, conversation._id, actorId);
});

/** POST /api/conversations/:id/admins { userId } — group admins only. */
export const promoteGroupAdmin = asyncHandler(async (req, res) => {
  const actorId = req.user._id;
  const targetKey = req.body.userId.toLowerCase();

  const conversation = await loadConversationForMember(req.params.id, actorId);
  assertGroupAdmin(conversation, actorId);

  const memberIds = conversation.members.map((id) => id.toString());
  if (!memberIds.includes(targetKey)) {
    throw new AppError('That user is not a member of this group', 404, 'MEMBER_NOT_FOUND');
  }

  const alreadyAdmin = (conversation.admins ?? []).some(
    (id) => id.toString() === targetKey
  );

  if (!alreadyAdmin) {
    await Conversation.updateOne(
      { _id: conversation._id },
      { $addToSet: { admins: targetKey } }
    );

    const populated = await loadPopulatedConversation(conversation._id);
    announceConversationUpdated(populated);
    announceNewMessage(
      await createSystemMessage({
        conversationId: conversation._id,
        senderId: actorId,
        text: `${displayNameOf(req.user)} made ${memberName(populated, targetKey)} an admin`,
      })
    );
  }

  await respondWithConversation(res, conversation._id, actorId);
});

/**
 * POST /api/conversations/:id/keys { baseVersion, groupKeys } — group admins
 * rotating the group key (after a member was removed or left, so the removed
 * member loses access to new messages).
 *
 * The client generates a brand-new group key, wraps it for every CURRENT
 * member (including itself) at version baseVersion + 1 and sends the
 * envelopes. The server never sees the key itself and cannot check the
 * cryptography, but it guarantees the protocol:
 *   - `baseVersion` must equal the stored currentKeyVersion; otherwise the
 *     rotation loses a race against another admin → 409 STALE_KEY_VERSION
 *     (the client keeps the key it receives through "conversation:keys").
 *   - exactly one envelope per current member, all at the new version, all
 *     wrappedBy the acting admin — nobody can be left without access.
 *   - old envelopes are kept (history stays decryptable for members who were
 *     there; the removed member keeps their old keys and old messages).
 *
 * On success every member receives their own fresh envelope via
 * "conversation:keys" and the room receives "conversation:updated".
 */
export const rotateGroupKeys = asyncHandler(async (req, res) => {
  const actorId = req.user._id;
  const actorKey = actorId.toString();
  const conversation = await loadConversationForMember(req.params.id, actorId);
  assertGroupAdmin(conversation, actorId);

  const { baseVersion, groupKeys } = req.body; // zod-validated
  const currentVersion = conversation.currentKeyVersion ?? 1;

  if (baseVersion !== currentVersion) {
    throw new AppError(
      'The group key was already rotated by another admin',
      409,
      'STALE_KEY_VERSION'
    );
  }

  const newVersion = baseVersion + 1;
  const memberIds = conversation.members.map((id) => id.toString());
  const memberSet = new Set(memberIds);

  const seen = new Set();
  const newKeys = [];
  for (const key of groupKeys) {
    const keyUserId = key.userId.toLowerCase();
    if (!memberSet.has(keyUserId)) {
      throw AppError.badRequest(
        'groupKeys entries must reference conversation members',
        'VALIDATION_ERROR'
      );
    }
    if (key.wrappedBy.toLowerCase() !== actorKey) {
      throw AppError.badRequest(
        'groupKeys wrappedBy must be the acting admin',
        'VALIDATION_ERROR'
      );
    }
    if (key.version !== newVersion) {
      throw AppError.badRequest(
        `every envelope must use the new key version ${newVersion}`,
        'VALIDATION_ERROR'
      );
    }
    if (seen.has(keyUserId)) {
      throw AppError.badRequest(
        `duplicate groupKeys entry for ${keyUserId}`,
        'VALIDATION_ERROR'
      );
    }
    seen.add(keyUserId);
    newKeys.push({
      userId: keyUserId,
      version: key.version,
      wrappedKey: key.wrappedKey,
      iv: key.iv,
      wrappedBy: actorKey,
    });
  }

  if (seen.size !== memberIds.length) {
    const missing = memberIds.filter((id) => !seen.has(id));
    throw AppError.badRequest(
      `groupKeys must cover every current member (missing: ${missing.join(', ')})`,
      'INCOMPLETE_KEYS'
    );
  }

  // Compare-and-swap on currentKeyVersion: a concurrent rotation from another
  // admin loses instead of silently overwriting the first admin's key.
  const updated = await Conversation.findOneAndUpdate(
    { _id: conversation._id, currentKeyVersion: baseVersion },
    {
      $push: { groupKeys: { $each: newKeys } },
      $set: { currentKeyVersion: newVersion },
    },
    { returnDocument: 'after' }
  )
    .select('_id members groupKeys currentKeyVersion')
    .lean();

  if (!updated) {
    throw new AppError(
      'The group key was already rotated by another admin',
      409,
      'STALE_KEY_VERSION'
    );
  }

  // Each member receives only their own fresh envelope; the room learns the
  // new version (no key material in the broadcast).
  announceConversationKeys(updated);

  const populated = await loadPopulatedConversation(conversation._id);
  announceConversationUpdated(populated);

  await respondWithConversation(res, conversation._id, actorId);
});
