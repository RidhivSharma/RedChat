import rateLimit from 'express-rate-limit';

/**
 * Rate limiter for /api/auth/*: 20 requests per IP per 15 minutes.
 * Responds with the shared error JSON format.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: { message: 'Too many attempts, please try again later', code: 'RATE_LIMITED' },
    });
  },
});

/**
 * Baseline limiter for the whole /api surface (auth routes have their own,
 * stricter limiter on top): 300 requests per minute and IP. High enough for
 * normal chat usage (pagination, refetches after reconnects) but low enough
 * to blunt scripted abuse. Disabled for the test process so suites that make
 * many requests to one loopback IP stay deterministic.
 */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  handler: (_req, res) => {
    res.status(429).json({
      error: { message: 'Too many requests, please try again later', code: 'RATE_LIMITED' },
    });
  },
});

export default authLimiter;
