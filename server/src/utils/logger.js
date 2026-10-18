import { env } from '../config/env.js';

/**
 * Minimal structured logger.
 *
 * Rules:
 *   - NEVER pass message contents, ciphertexts, tokens, passwords or key
 *     material in `meta`. The redaction below is a last-resort safety net,
 *     not a license to log secrets.
 *   - production: one JSON object per line (easy to ship to any log sink).
 *   - development/test: one readable line per entry.
 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const threshold =
  LEVELS[process.env.LOG_LEVEL] ?? (env.NODE_ENV === 'production' ? LEVELS.info : LEVELS.debug);

const MAX_DEPTH = 4;

/** Key names that must never appear in logs, even by accident. */
const SENSITIVE_KEY_RE =
  /pass|token|secret|authoriz|cookie|jwt|ciphertext|wrappedkey|privatekey|^iv$|^salt$/i;

function isSensitiveKey(key) {
  return SENSITIVE_KEY_RE.test(key);
}

/** Error → plain object; stacks only outside production. */
function serializeError(error) {
  const out = {
    name: error.name,
    message: error.message,
  };
  if (error.code !== undefined) out.code = error.code;
  if (error.statusCode !== undefined) out.statusCode = error.statusCode;
  if (error.type !== undefined) out.type = error.type;
  if (env.NODE_ENV !== 'production' && error.stack) out.stack = error.stack;
  return out;
}

function serializeValue(value, depth) {
  if (value === null || value === undefined) return value;

  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return value;
  if (type === 'bigint') return value.toString();
  if (type === 'function' || type === 'symbol') return `[${type}]`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return serializeError(value);
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;

  if (depth >= MAX_DEPTH) return '[max depth]';

  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item, depth + 1));
  }

  if (type === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? '[redacted]' : serializeValue(item, depth + 1);
    }
    return out;
  }

  return String(value);
}

function formatPretty(record) {
  const { time, level, message, meta, ...rest } = record;
  const extras = { ...rest, ...(meta !== undefined ? { meta } : {}) };
  const suffix = Object.keys(extras).length > 0 ? ` ${JSON.stringify(extras)}` : '';
  return `[${time}] ${level.toUpperCase()} ${message}${suffix}`;
}

function emit(level, message, meta) {
  if (LEVELS[level] > threshold) return;

  const record = {
    time: new Date().toISOString(),
    level,
    message: String(message),
  };
  if (meta !== undefined) record.meta = serializeValue(meta, 0);

  const line =
    env.NODE_ENV === 'production' ? JSON.stringify(record) : formatPretty(record);

  // Logs go to stdout/stderr; error and warn to stderr so they can be
  // separated in any deployment.
  if (LEVELS[level] <= LEVELS.warn) {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

export const logger = {
  error: (message, meta) => emit('error', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  info: (message, meta) => emit('info', message, meta),
  debug: (message, meta) => emit('debug', message, meta),
};

export default logger;
