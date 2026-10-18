import mongoose from 'mongoose';

const { Schema } = mongoose;

const receiptSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const messageSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ciphertext: { type: String, required: true },
    iv: { type: String, default: null },
    keyVersion: { type: Number, default: 1 },
    encrypted: { type: Boolean, default: true },
    // 'user' = authored by a member; 'system' = server-generated group activity
    // line ("Alex added Sam"). System messages are plain text (enforced by the
    // creator), never encrypted and never receipt-tracked.
    type: { type: String, enum: ['user', 'system'], default: 'user' },
    // Client-generated id, unique per sender — makes sends idempotent / deduplicated.
    clientId: { type: String, required: true, trim: true },
    deliveredTo: { type: [receiptSchema], default: [] },
    readBy: { type: [receiptSchema], default: [] },
    deletedForEveryone: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// History pagination per conversation.
messageSchema.index({ conversationId: 1, createdAt: -1 });
// Connect-time delivery catch-up: "undelivered for this user" per conversation.
messageSchema.index({ conversationId: 1, 'deliveredTo.user': 1 });
// Deduplication: the same clientId can never be stored twice for one sender.
messageSchema.index({ sender: 1, clientId: 1 }, { unique: true });
// Unread counts: "messages from others I have not read yet" per conversation.
messageSchema.index({ conversationId: 1, sender: 1, 'readBy.user': 1 });

export const Message = mongoose.model('Message', messageSchema);
export default Message;
