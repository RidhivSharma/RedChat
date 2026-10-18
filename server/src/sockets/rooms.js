/** Room names shared by every socket module. */
export const personalRoom = (userId) => `user:${userId}`;
export const conversationRoom = (conversationId) => `conv:${conversationId}`;
