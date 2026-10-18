import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { clientOrigins } from './config/env.js';
import { AppError } from './utils/AppError.js';
import { logger } from './utils/logger.js';
import { apiLimiter } from './middleware/rateLimit.js';
import authRoutes from './routes/auth.routes.js';
import userRoutes from './routes/user.routes.js';
import conversationRoutes from './routes/conversation.routes.js';
import messageRoutes from './routes/message.routes.js';

const app = express();

// Correct client IPs (and therefore rate limiting) behind a reverse proxy.
app.set('trust proxy', 1);
app.disable('x-powered-by');

/**
 * Request log: method, path (never the query string or body), status and
 * duration. Health checks are skipped so monitoring traffic cannot flood the
 * logs.
 */
app.use((req, res, next) => {
  if (req.path === '/api/health') {
    next();
    return;
  }

  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.info('request', {
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
    });
  });
  next();
});

app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser/same-origin requests (no Origin header) and only
      // the configured client origins (CLIENT_URL, comma-separated) —
      // everything else gets no CORS headers.
      if (!origin || clientOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
  })
);

// Baseline abuse protection for the whole API (auth routes additionally use
// the stricter authLimiter). Runs before body parsing so oversized or
// scripted floods are rejected as early as possible.
app.use('/api', apiLimiter);

app.use(express.json({ limit: '100kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/messages', messageRoutes);

// 404 — anything that did not match a route above.
app.use((req, _res, next) => {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404, 'NOT_FOUND'));
});

/**
 * Maps low-level failures (body parsing, Mongoose, unique indexes) onto the
 * shared AppError shape so every response has a safe message and a stable
 * code — internal details never reach the client.
 */
function normalizeError(err) {
  if (err instanceof AppError) return err;

  if (err?.type === 'entity.parse.failed') {
    return new AppError('Invalid JSON body', 400, 'VALIDATION_ERROR');
  }
  if (err?.type === 'entity.too.large' || err?.statusCode === 413 || err?.status === 413) {
    return new AppError('Request body is too large', 413, 'PAYLOAD_TOO_LARGE');
  }
  if (err?.name === 'ValidationError') {
    return new AppError('Validation failed', 400, 'VALIDATION_ERROR');
  }
  if (err?.name === 'CastError') {
    return new AppError('Invalid identifier', 400, 'VALIDATION_ERROR');
  }
  if (err?.code === 11000) {
    return new AppError('A record with these values already exists', 409, 'DUPLICATE_KEY');
  }

  return err;
}

// Central error handler — the single place that formats
// { error: { message, code } } for every failure.
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  const normalized = normalizeError(err);
  const statusCode = Number.isInteger(normalized.statusCode) ? normalized.statusCode : 500;
  const code =
    typeof normalized.code === 'string' && normalized.code ? normalized.code : 'INTERNAL_ERROR';
  const message =
    statusCode >= 500 && !normalized.isOperational ? 'Internal server error' : normalized.message;

  if (statusCode >= 500) {
    // Full error (with stack outside production) is logged server-side only.
    logger.error('request failed', {
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: statusCode,
      code,
      error: normalized,
    });
  }

  return res.status(statusCode).json({ error: { message, code } });
});

export default app;
