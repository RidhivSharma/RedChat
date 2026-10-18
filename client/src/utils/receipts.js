// Delivery/read receipt helpers for own message bubbles.
//
// Ticks:  one grey tick = sent, two grey ticks = delivered, two blue ticks = read.
// In a group the ticks only turn delivered/read once EVERY other member has
// delivered/read — `receiptDetails()` exposes the per-member breakdown for the
// "Message info" view.

/** True when `userId` has the given receipt row ({ user, at }). */
export function hasReceipt(receipts, userId) {
  return (receipts ?? []).some((receipt) => receipt.user === userId);
}

/** Everyone the ticks depend on: the members except the current user. */
export function otherMembers(conversation, currentUserId) {
  return (conversation?.members ?? []).filter((member) => member.id !== currentUserId);
}

/**
 * Tick state of an own message: "sent" | "delivered" | "read".
 * Unknown members count as not delivered (a safe default while members load).
 */
export function receiptState(message, conversation, currentUserId) {
  const others = otherMembers(conversation, currentUserId);
  if (others.length === 0) return 'sent';

  const readBy = new Set((message.readBy ?? []).map((receipt) => receipt.user));
  if (others.every((member) => readBy.has(member.id))) return 'read';

  const deliveredTo = new Set((message.deliveredTo ?? []).map((receipt) => receipt.user));
  if (others.every((member) => deliveredTo.has(member.id))) return 'delivered';

  return 'sent';
}

/** Per-member delivery/read times (null = still pending) for the info view. */
export function receiptDetails(message, conversation, currentUserId) {
  const deliveredAt = new Map(
    (message.deliveredTo ?? []).map((receipt) => [receipt.user, receipt.at])
  );
  const readAt = new Map((message.readBy ?? []).map((receipt) => [receipt.user, receipt.at]));

  return otherMembers(conversation, currentUserId).map((user) => ({
    user,
    deliveredAt: deliveredAt.get(user.id) ?? null,
    readAt: readAt.get(user.id) ?? null,
  }));
}

/** Tooltip/aria label for the tick button — the "Seen by N" detail. */
export function receiptLabel(state, details) {
  const total = details.length;
  if (total === 0) return 'Sent';

  if (state === 'read') {
    const count = details.filter((entry) => entry.readAt).length;
    if (total === 1) return `Seen by ${details[0].user.displayName}`;
    return `Seen by ${count} of ${total}`;
  }

  if (state === 'delivered') {
    const count = details.filter((entry) => entry.deliveredAt).length;
    if (total === 1) return `Delivered to ${details[0].user.displayName}`;
    return `Delivered to ${count} of ${total}`;
  }

  return 'Sent — show message info';
}
