import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { getUser, searchUsers, updateMe } from '../controllers/user.controller.js';
import { encryptedPrivateKeySchema, publicKeySchema } from './auth.routes.js';

export const updateMeSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(1, 'Display name must be at least 1 character')
      .max(40, 'Display name must be at most 40 characters')
      .optional(),
    avatarColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'avatarColor must be a hex color like #6366f1')
      .optional(),
    // E2EE material — used once to equip accounts created before encryption
    // existed (see updateMe). Never accepted to overwrite existing keys.
    publicKey: publicKeySchema.optional(),
    encryptedPrivateKey: encryptedPrivateKeySchema.optional(),
  })
  .refine(
    (data) =>
      data.displayName !== undefined ||
      data.avatarColor !== undefined ||
      data.publicKey !== undefined ||
      data.encryptedPrivateKey !== undefined,
    { message: 'Provide at least one field to update' }
  )
  .refine(
    (data) =>
      (data.publicKey === undefined) === (data.encryptedPrivateKey === undefined),
    { message: 'publicKey and encryptedPrivateKey must be provided together' }
  );

const router = Router();

// Every route below requires a valid token.
router.use(requireAuth);

router.get('/search', searchUsers); // must stay before '/:id'
router.patch('/me', validateBody(updateMeSchema), updateMe);
router.get('/:id', getUser);

export default router;
