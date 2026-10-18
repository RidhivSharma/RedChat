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

export default authLimiter;
