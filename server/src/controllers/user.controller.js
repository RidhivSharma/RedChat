import { z } from 'zod';
import { User } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { escapeRegex } from '../utils/escapeRegex.js';

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(40),
});

const userIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/);

export const searchUsers = asyncHandler(async (req, res) => {
  const parsed = searchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw new AppError('Query parameter "q" (1-40 characters) is required', 400, 'VALIDATION_ERROR');
  }

  // Case-insensitive prefix match, with the user input escaped.
  const prefixRegex = new RegExp(`^${escapeRegex(parsed.data.q)}`, 'i');

  const users = await User.find({
    _id: { $ne: req.user._id },
    $or: [{ username: prefixRegex }, { displayName: prefixRegex }],
  })
    .select('username displayName avatarColor publicKey lastSeen')
    .sort({ username: 1 })
    .limit(20);

  res.json({ users: users.map((user) => user.toPublicProfileJSON()) });
});

export const getUser = asyncHandler(async (req, res) => {
  if (!userIdSchema.safeParse(req.params.id).success) {
    throw new AppError('Invalid user id', 400, 'VALIDATION_ERROR');
  }

  const user = await User.findById(req.params.id).select(
    'username displayName avatarColor publicKey lastSeen'
  );
  if (!user) {
    throw new AppError('User not found', 404, 'USER_NOT_FOUND');
  }

  res.json({ user: user.toPublicProfileJSON() });
});

export const updateMe = asyncHandler(async (req, res) => {
  const { displayName, avatarColor, publicKey, encryptedPrivateKey } = req.body; // zod-validated

  if (displayName !== undefined) req.user.displayName = displayName;
  if (avatarColor !== undefined) req.user.avatarColor = avatarColor;

  // One-time E2EE setup for accounts created before encryption existed.
  // Keys are write-once: replacing them would silently break every direct
  // chat (the partner still derives the old shared key), so a second attempt
  // is rejected instead.
  if (publicKey !== undefined) {
    if (req.user.publicKey || req.user.encryptedPrivateKey?.ciphertext) {
      throw new AppError('Encryption keys are already set for this account', 409, 'KEYS_ALREADY_SET');
    }
    req.user.publicKey = publicKey;
    req.user.encryptedPrivateKey = encryptedPrivateKey;
  }

  await req.user.save();

  res.json({ user: req.user.toPublicJSON() });
});
