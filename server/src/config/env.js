import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load server/.env first (most specific), then fall back to the repo-root .env.
// dotenv never overrides variables that are already set, so precedence is:
// process.env > server/.env > repo-root .env
dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
dotenv.config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

/**
 * MongoDB requires special characters in credentials to be percent-encoded
 * ("@" → "%40", ":" → "%3A", ...). Hand-typed connection strings often miss
 * that, and the driver then rejects the whole URI with "Invalid connection
 * string". When an unencoded separator is detected inside the credentials we
 * re-encode them in memory and warn, so the .env can be fixed properly.
 */
function normalizeMongoUri(uri) {
  const schemeEnd = uri.indexOf('://');
  if (schemeEnd === -1) return uri;

  const rest = uri.slice(schemeEnd + 3);
  const firstAt = rest.indexOf('@');
  const lastAt = rest.lastIndexOf('@');
  if (firstAt === -1 || firstAt === lastAt) return uri; // single "@" = valid separator

  // If the extra "@" sits after a "/", it belongs to a path/query — leave it.
  const firstSlash = rest.indexOf('/');
  if (firstSlash !== -1 && lastAt > firstSlash) return uri;

  const scheme = uri.slice(0, schemeEnd);
  const userinfo = rest.slice(0, lastAt);
  const hostAndPath = rest.slice(lastAt + 1);
  const colon = userinfo.indexOf(':');
  const user = colon === -1 ? userinfo : userinfo.slice(0, colon);
  const pass = colon === -1 ? '' : userinfo.slice(colon + 1);

  // Do not double-encode: if a "%" is present, assume the value is already
  // partially percent-encoded and only encode raw separators.
  const encode = (value) =>
    value.includes('%')
      ? value.replace(/[@:/?#\[\] ]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
      : encodeURIComponent(value);

  console.warn(
    '[env] MONGODB_URI contained unencoded special characters in its credentials - fixed in memory for this run. ' +
      'Percent-encode them in your .env (e.g. "@" -> "%40") to silence this warning.'
  );

  return `${scheme}://${encode(user)}:${encode(pass)}@${hostAndPath}`;
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  MONGODB_URI: z
    .string()
    .trim()
    .min(1, 'MONGODB_URI is required (e.g. mongodb://127.0.0.1:27017/chatwave)')
    .refine(
      (value) => value.startsWith('mongodb://') || value.startsWith('mongodb+srv://'),
      'MONGODB_URI must start with mongodb:// or mongodb+srv://'
    )
    .transform(normalizeMongoUri),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters long'),
  JWT_EXPIRES_IN: z.string().trim().min(1).default('7d'),
  CLIENT_URL: z.string().trim().min(1).default('http://localhost:5173'),
  REQUIRE_E2EE: z
    .string()
    .default('false')
    .transform((value) => value.trim().toLowerCase() === 'true'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('[env] Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    const key = issue.path.join('.') || '(root)';
    console.error(`  - ${key}: ${issue.message}`);
  }
  console.error('[env] Fix the values above. See server/.env.example for reference.');
  process.exit(1);
}

export const env = Object.freeze(parsed.data);
export default env;
