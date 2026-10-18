/**
 * Simple in-memory sliding-window limiter. Create one instance per socket
 * (or per socket feature) — it disappears with the socket.
 *
 *   const consume = createSlidingWindowLimiter({ limit: 20, windowMs: 10_000 });
 *   if (!consume()) throw new AppError('...', 429, 'RATE_LIMITED');
 */
export function createSlidingWindowLimiter({ limit, windowMs }) {
  const timestamps = [];

  return function consume(now = Date.now()) {
    const cutoff = now - windowMs;
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }
    if (timestamps.length >= limit) {
      return false;
    }
    timestamps.push(now);
    return true;
  };
}
