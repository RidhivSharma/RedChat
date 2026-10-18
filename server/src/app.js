import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env.js';
import { AppError } from './utils/AppError.js';
import authRoutes from './routes/auth.routes.js';
import userRoutes from './routes/user.routes.js';
import conversationRoutes from './routes/conversation.routes.js';
import messageRoutes from './routes/message.routes.js';

const app = express();

// Correct client IPs (and therefore rate limiting) behind a reverse proxy.
app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser/same-origin requests (no Origin header) and only
      // the configured client URL — everything else gets no CORS headers.
      if (!origin || origin === env.CLIENT_URL) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
  })
);
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

// Central error handler — the single place that formats
// { error: { message, code } } for every failure.
app.use((err, _req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  const statusCode = Number.isInteger(err.statusCode) ? err.statusCode : 500;
  const code = typeof err.code === 'string' && err.code ? err.code : 'INTERNAL_ERROR';
  const message = statusCode >= 500 && !err.isOperational ? 'Internal server error' : err.message;

  if (statusCode >= 500) {
    console.error('[error]', err);
  }

  return res.status(statusCode).json({ error: { message, code } });
});

export default app;
