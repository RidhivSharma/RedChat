import mongoose from 'mongoose';

const { Schema } = mongoose;

const groupKeySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    version: { type: Number, required: true },
    // Mirrors the API limits (routes/conversation.routes.js).
    wrappedKey: { type: String, required: true, maxlength: 2000 },
    iv: { type: String, required: true, maxlength: 64 },
    wrappedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { _id: false }
);

const conversationSchema = new Schema(
  {
    type: { type: String, enum: ['direct', 'group'], required: true },
    members: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], required: true },
    // Only for direct conversations: the two member ids, sorted and joined.
    // Unique + sparse so groups (which have no directKey) are unaffected.
    directKey: { type: String, unique: true, sparse: true },
    name: { type: String, trim: true, default: '', maxlength: 50 },
    admins: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    groupKeys: { type: [groupKeySchema], default: [] },
    currentKeyVersion: { type: Number, default: 1 },
    lastMessageAt: { type: Date, default: null },
    lastMessageId: { type: Schema.Types.ObjectId, ref: 'Message', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// "My conversations, most recent first" — the members prefix also serves member lookups.
conversationSchema.index({ members: 1, lastMessageAt: -1 });

export const Conversation = mongoose.model('Conversation', conversationSchema);
export default Conversation;
