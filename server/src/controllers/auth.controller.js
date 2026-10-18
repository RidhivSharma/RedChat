import bcrypt from 'bcryptjs';
import { User } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { randomAvatarColor } from '../utils/avatarColor.js';
import { signAuthToken } from '../utils/token.js';

const SALT_ROUNDS = 10;

// Compared against when the username does not exist, so login timing does not
// reveal whether an account exists.
const DUMMY_HASH = bcrypt.hashSync('login-timing-placeholder', SALT_ROUNDS);

export const register = asyncHandler(async (req, res) => {
  const {
    username,
    displayName,
    password,
    publicKey = null,
    encryptedPrivateKey = null,
  } = req.body; // already zod-validated; username is lowercased

  const existing = await User.exists({ username });
  if (existing) {
    throw AppError.conflict('Username is already taken', 'USERNAME_TAKEN');
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  let user;
  try {
    user = await User.create({
      username,
      displayName,
      passwordHash,
      avatarColor: randomAvatarColor(),
      publicKey,
      encryptedPrivateKey,
    });
  } catch (err) {
    // Unique index race: two registrations for the same username at once.
    if (err?.code === 11000) {
      throw AppError.conflict('Username is already taken', 'USERNAME_TAKEN');
    }
    throw err;
  }

  const token = signAuthToken(user._id);
  res.status(201).json({ token, user: user.toPublicJSON() });
});

export const login = asyncHandler(async (req, res) => {
  const { username, password } = req.body; // already zod-validated; username lowercased

  const user = await User.findOne({ username });
  const passwordMatches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || !passwordMatches) {
    // Same response for unknown user and wrong password.
    throw new AppError('Invalid username or password', 401, 'INVALID_CREDENTIALS');
  }

  user.lastSeen = new Date();
  await user.save();

  const token = signAuthToken(user._id);
  res.json({
    token,
    user: user.toPublicJSON(),
    encryptedPrivateKey: user.encryptedPrivateKey ?? null,
  });
});

export const me = asyncHandler(async (req, res) => {
  res.json({
    user: req.user.toPublicJSON(),
    encryptedPrivateKey: req.user.encryptedPrivateKey ?? null,
  });
});
