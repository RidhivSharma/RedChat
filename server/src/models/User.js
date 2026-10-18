import mongoose from 'mongoose';

const { Schema } = mongoose;

const encryptedPrivateKeySchema = new Schema(
  {
    ciphertext: { type: String, default: null },
    iv: { type: String, default: null },
    salt: { type: String, default: null },
    iterations: { type: Number, default: null },
  },
  { _id: false }
);

const userSchema = new Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    displayName: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true },
    avatarColor: { type: String, default: '#6366f1' },
    // Public key (JWK serialized as a JSON string) — safe to share with other users.
    publicKey: { type: String, default: null },
    encryptedPrivateKey: { type: encryptedPrivateKeySchema, default: null },
    lastSeen: { type: Date, default: Date.now },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    // Safety net: even if a document is serialized directly, private fields never leave.
    toJSON: {
      transform(_doc, ret) {
        delete ret.passwordHash;
        delete ret.encryptedPrivateKey;
        delete ret.__v;
        return ret;
      },
    },
  }
);

/**
 * Public shape of a user, safe to send to other users.
 * Never exposes passwordHash or encryptedPrivateKey.
 */
userSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    username: this.username,
    displayName: this.displayName,
    avatarColor: this.avatarColor,
    publicKey: this.publicKey,
    lastSeen: this.lastSeen,
    createdAt: this.createdAt,
  };
};

/**
 * Minimal public profile (search results, user pages):
 * id, username, displayName, avatarColor, publicKey, lastSeen.
 */
userSchema.methods.toPublicProfileJSON = function toPublicProfileJSON() {
  return {
    id: this._id.toString(),
    username: this.username,
    displayName: this.displayName,
    avatarColor: this.avatarColor,
    publicKey: this.publicKey,
    lastSeen: this.lastSeen,
  };
};

export const User = mongoose.model('User', userSchema);
export default User;
