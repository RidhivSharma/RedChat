// Display helpers for conversations (direct chats are titled by the other
// member; groups by their name).

// Mirrors the server palette (server/src/utils/avatarColor.js) so group
// avatars look at home next to user avatars.
const GROUP_COLORS = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#10b981',
  '#06b6d4',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#d946ef',
  '#ec4899',
];

/** The member of a direct conversation that is not the current user. */
export function otherMember(conversation, currentUserId) {
  return (
    (conversation?.members ?? []).find((member) => member.id !== currentUserId) ?? null
  );
}

export function conversationTitle(conversation, currentUserId) {
  if (!conversation) return '';
  if (conversation.type === 'group') return conversation.name || 'Group chat';
  return otherMember(conversation, currentUserId)?.displayName || 'Unknown user';
}

/** Props for <Avatar/>: a user for direct chats, a deterministic name color for groups. */
export function conversationAvatar(conversation, currentUserId) {
  if (!conversation) return { name: '?' };
  if (conversation.type !== 'group') {
    const other = otherMember(conversation, currentUserId);
    return { user: other ?? undefined, name: other?.displayName ?? '?' };
  }

  const key = String(conversation.id ?? conversation.name ?? '');
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) % 100000;
  }
  return {
    name: conversation.name || 'Group chat',
    color: GROUP_COLORS[hash % GROUP_COLORS.length],
  };
}

/** Secondary line in the conversation list ("@alex" or "4 members"). */
export function conversationSubtitle(conversation, currentUserId) {
  if (!conversation) return '';
  if (conversation.type === 'group') {
    const count = conversation.members?.length ?? 0;
    return `${count} member${count === 1 ? '' : 's'}`;
  }
  const other = otherMember(conversation, currentUserId);
  return other?.username ? `@${other.username}` : '';
}

/** True when `userId` is one of the group's admins. */
export function isGroupAdmin(conversation, userId) {
  if (!conversation || !userId) return false;
  return (conversation.admins ?? []).includes(userId);
}

export default conversationTitle;
