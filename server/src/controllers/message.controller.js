import { Message } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { OBJECT_ID_RE } from '../utils/conversationAccess.js';
import { deleteMessageForEveryone } from '../utils/messageService.js';
import { MESSAGE_FIELDS, serializeMessage } from '../utils/serialize.js';

/**
 * DELETE /api/messages/:id
 * "Delete for everyone": only the sender may do it, content is unrecoverable,
 * and deleting an already-deleted message is idempotent. The shared
 * messageService performs the sender check and the update so the Socket.io
 * layer deletes identically.
 */
export const deleteMessage = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (!OBJECT_ID_RE.test(id)) {
    throw AppError.badRequest('Invalid message id', 'VALIDATION_ERROR');
  }

  const message = await Message.findById(id).select(MESSAGE_FIELDS).lean();
  if (!message) {
    throw new AppError('Message not found', 404, 'MESSAGE_NOT_FOUND');
  }

  const { message: updated } = await deleteMessageForEveryone({
    message,
    userId: req.user._id,
  });

  res.json({ message: serializeMessage(updated) });
});
