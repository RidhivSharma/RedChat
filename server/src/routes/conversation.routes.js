import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import {
  addGroupMembers,
  createDirectConversation,
  createGroupConversation,
  getConversation,
  listConversations,
  listMessages,
  postMessage,
  promoteGroupAdmin,
  removeGroupMember,
  renameConversation,
  rotateGroupKeys,
} from '../controllers/conversation.controller.js';
import {
  MAX_CIPHERTEXT_LENGTH,
  MAX_CLIENT_ID_LENGTH,
  MAX_IV_LENGTH,
} from '../utils/messageService.js';

const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'must be a 24-character hex id');

/**
 * Group key envelopes. A wrapped AES key is at most a few hundred base64
 * characters (an RSA-4096 block is 512 bytes -> 684 base64 chars), so 2000
 * leaves ample headroom while keeping a single envelope small. The request
 * body limit (100kb) is the outer bound: a pathologically large "add many
 * members x many versions" request is rejected by express with 413 before it
 * ever reaches zod.
 */
export const MAX_WRAPPED_KEY_LENGTH = 2000;
export const MAX_GROUP_KEY_IV_LENGTH = 64;

const groupKeySchema = z.object({
  userId: objectIdSchema,
  version: z.number().int().positive().max(10_000),
  wrappedKey: z
    .string()
    .min(1)
    .max(MAX_WRAPPED_KEY_LENGTH, `wrappedKey must be at most ${MAX_WRAPPED_KEY_LENGTH} characters`),
  iv: z
    .string()
    .min(1)
    .max(MAX_GROUP_KEY_IV_LENGTH, `iv must be at most ${MAX_GROUP_KEY_IV_LENGTH} characters`),
  wrappedBy: objectIdSchema,
});

export const createDirectSchema = z.object({
  userId: objectIdSchema,
});

export const groupNameSchema = z
  .string()
  .trim()
  .min(1, 'Group name is required')
  .max(50, 'Group name must be at most 50 characters');

export const createGroupSchema = z.object({
  name: groupNameSchema,
  memberIds: z
    .array(objectIdSchema)
    .min(2, 'A group needs at least 2 members besides the creator')
    .max(50, 'A group can have at most 50 members besides the creator')
    .refine(
      (ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length,
      'memberIds must not contain duplicates'
    ),
  // Encryption phase data — optional until then. A new group has one key
  // version; at most 51 members exist, so 100 envelopes is slack.
  groupKeys: z.array(groupKeySchema).max(100).default([]),
});

/** POST /:id/members — group admins adding members. */
export const addMembersSchema = z.object({
  userIds: z
    .array(objectIdSchema)
    .min(1, 'Pick at least one user to add')
    .max(50, 'A group can have at most 50 members besides the creator')
    .refine(
      (ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length,
      'userIds must not contain duplicates'
    ),
  // Key envelopes for the newcomers (all existing key versions). Optional so
  // legacy/unencrypted groups can still add members; validated in the handler.
  groupKeys: z.array(groupKeySchema).max(300).default([]),
});

/**
 * POST /:id/keys — group admins rotating the group key after a membership
 * change. `baseVersion` guards against two admins rotating concurrently: the
 * server only accepts the rotation that builds on the version it knows.
 */
export const rotateKeysSchema = z.object({
  baseVersion: z.number().int().positive().max(10_000),
  groupKeys: z
    .array(groupKeySchema)
    .min(1, 'groupKeys is required')
    .max(100, 'groupKeys has too many entries'),
});

/** PATCH /:id — renaming a group. */
export const renameGroupSchema = z.object({
  name: groupNameSchema,
});

/** POST /:id/admins — promoting a member. */
export const promoteAdminSchema = z.object({
  userId: objectIdSchema,
});

export const createMessageSchema = z
  .object({
    ciphertext: z
      .string()
      .min(1, 'ciphertext is required')
      .max(
        MAX_CIPHERTEXT_LENGTH,
        `ciphertext must be at most ${MAX_CIPHERTEXT_LENGTH} characters`
      ),
    // An empty iv is allowed for plaintext-phase payloads (encrypted: false);
    // the superRefine below still requires a non-empty iv when encrypted.
    iv: z.string().max(MAX_IV_LENGTH).optional(),
    keyVersion: z.number().int().positive().max(10_000).default(1),
    encrypted: z.boolean().default(true),
    clientId: z
      .string()
      .trim()
      .min(1, 'clientId is required')
      .max(MAX_CLIENT_ID_LENGTH, `clientId must be at most ${MAX_CLIENT_ID_LENGTH} characters`),
  })
  .superRefine((data, ctx) => {
    if (data.encrypted && !data.iv) {
      ctx.addIssue({
        code: 'custom',
        path: ['iv'],
        message: 'iv is required when encrypted is true',
      });
    }
  });

export const messageQuerySchema = z.object({
  // Either a message id (exact cursor) or an ISO date.
  before: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const router = Router();

// Every route below requires a valid token and checks membership.
router.use(requireAuth);

router.post('/direct', validateBody(createDirectSchema), createDirectConversation);
router.post('/group', validateBody(createGroupSchema), createGroupConversation);
router.get('/', listConversations);
router.get('/:id', getConversation);
router.get('/:id/messages', validateQuery(messageQuerySchema), listMessages);
router.post('/:id/messages', validateBody(createMessageSchema), postMessage);

// Group management.
router.post('/:id/members', validateBody(addMembersSchema), addGroupMembers);
router.delete('/:id/members/:userId', removeGroupMember);
router.post('/:id/keys', validateBody(rotateKeysSchema), rotateGroupKeys);
router.patch('/:id', validateBody(renameGroupSchema), renameConversation);
router.post('/:id/admins', validateBody(promoteAdminSchema), promoteGroupAdmin);

export default router;
