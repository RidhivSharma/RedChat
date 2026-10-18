// Test environment bootstrap. MUST be imported before any src/ module:
// it overrides process.env so src/config/env.js picks up the test database
// (process.env always wins over .env files).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same precedence as src/config/env.js: server/.env, then repo-root .env.
dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
dotenv.config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

const DEFAULT_URI = 'mongodb://127.0.0.1:27017/redchat';

/** Derives the test URI: the database name gets baked into "<name>_test". */
function toTestDatabaseUri(uri) {
  const [head, query = ''] = uri.split('?');
  const schemeEnd = head.indexOf('://');
  const scheme = head.slice(0, schemeEnd);
  const rest = head.slice(schemeEnd + 3);
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const dbName = slash === -1 || !rest.slice(slash + 1) ? 'redchat' : rest.slice(slash + 1);
  return `${scheme}://${authority}/${dbName}_test${query ? `?${query}` : ''}`;
}

export const TEST_DATABASE_URI = toTestDatabaseUri(process.env.MONGODB_URI ?? DEFAULT_URI);

process.env.MONGODB_URI = TEST_DATABASE_URI;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test-secret-please-change-0123456789';
process.env.JWT_EXPIRES_IN ??= '1h';
// Deterministic suite default; tests for the E2EE gate set this back to
// "true" before importing src/ modules.
process.env.REQUIRE_E2EE = 'false';

console.log('[tests] using database uri:', TEST_DATABASE_URI.replace(/\/\/[^@]*@/, '//***@'));
