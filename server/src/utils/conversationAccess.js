import { Conversation } from '../models/index.js';
import { AppError } from './AppError.js';
import { MEMBER_FIELDS } from './serialize.js';

export const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

/**
 * Loads a conversation by id and enforces membership:
 *   400 invalid id, 404 unknown conversation, 403 non-member.
 * Shared by the REST controllers and the Socket.io event handlers — every
 * conversation/message access goes through this helper.
 */
export async function loadConversationForMember(conversationId, userId, { populateMembers = false } = {}) {
  if (!OBJECT_ID_RE.test(String(conversationId ?? ''))) {
    throw AppError.badRequest('Invalid conversation id', 'VALIDATION_ERROR');
  }

  const base = Conversation.findById(conversationId);
  const query = populateMembers
    ? base.populate('members', MEMBER_FIELDS)
    : base.select('members admins type name createdBy currentKeyVersion groupKeys');
  const conversation = await query.lean();

  if (!conversation) {
    throw new AppError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND');
  }

  // Works for both plain member ids and populated member documents.
  const isMember = conversation.members.some(
    (member) => (member._id ?? member).toString() === userId.toString()
  );
  if (!isMember) {
    throw AppError.forbidden('You are not a member of this conversation', 'NOT_A_MEMBER');
  }

  return conversation;
}

/** Throws unless the conversation is a group. */
export function assertGroupConversation(conversation) {
  if (conversation.type !== 'group') {
    throw AppError.badRequest(
      'This action is only available for group conversations',
      'NOT_A_GROUP'
    );
  }
}

/** True when `userId` is one of the conversation's admins. */
export function isGroupAdmin(conversation, userId) {
  return (conversation.admins ?? []).some((id) => id.toString() === userId.toString());
}

/** Throws unless the conversation is a group AND `userId` is an admin of it. */
export function assertGroupAdmin(conversation, userId) {
  assertGroupConversation(conversation);
  if (!isGroupAdmin(conversation, userId)) {
    throw AppError.forbidden('Only group admins can do this', 'NOT_GROUP_ADMIN');
  }
}
