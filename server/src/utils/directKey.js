/**
 * Canonical key for a direct conversation: both member ids sorted and joined.
 * Every lookup goes through this helper so the value always matches the
 * unique sparse index on Conversation.directKey.
 */
export function buildDirectKey(idA, idB) {
  return [idA.toString(), idB.toString()].sort().join('_');
}

export default buildDirectKey;
