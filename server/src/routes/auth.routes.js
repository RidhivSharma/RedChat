import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { login, me, register } from '../controllers/auth.controller.js';
import { isBase64, isEcdhPublicKeyJwk } from '../utils/jwk.js';

export const publicKeySchema = z
  .string()
  .min(1)
  .max(10_000)
  .refine(isEcdhPublicKeyJwk, 'publicKey must be an ECDH P-256 JWK (JSON string)');

export const encryptedPrivateKeySchema = z.object({
  ciphertext: z.string().refine((value) => isBase64(value), 'ciphertext must be base64'),
  iv: z.string().refine((value) => isBase64(value, { maxLength: 256 }), 'iv must be base64'),
  salt: z.string().refine((value) => isBase64(value, { maxLength: 256 }), 'salt must be base64'),
  iterations: z.number().int().min(100_000).max(1_000_000),
});

export const registerSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, 'Username must be at least 3 characters')
    .max(20, 'Username must be at most 20 characters')
    .regex(/^[A-Za-z0-9_]+$/, 'Username can only contain letters, numbers and underscores')
    .transform((value) => value.toLowerCase()),
  displayName: z
    .string()
    .trim()
    .min(1, 'Display name is required')
    .max(40, 'Display name must be at most 40 characters'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(72, 'Password must be at most 72 characters'),
  // E2EE keys are optional until REQUIRE_E2EE=true, then they are required.
  publicKey: env.REQUIRE_E2EE ? publicKeySchema : publicKeySchema.optional(),
  encryptedPrivateKey: env.REQUIRE_E2EE
    ? encryptedPrivateKeySchema
    : encryptedPrivateKeySchema.optional(),
});

export const loginSchema = z.object({
  username: z.string().trim().min(1, 'Username is required').transform((value) => value.toLowerCase()),
  password: z.string().min(1, 'Password is required'),
});

const router = Router();

router.use(authLimiter);

router.post('/register', validateBody(registerSchema), register);
router.post('/login', validateBody(loginSchema), login);
router.get('/me', requireAuth, me);

export default router;
