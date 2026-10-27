// Tiny in-memory rate limiter (no extra dependency). Keyed by client IP; `app.set('trust proxy', 1)`
// makes req.ip the real visitor address behind Render / Railway / Fly / nginx.
// Set RATE_LIMIT=off in .env to disable (the automated tests do).
function rateLimit({ windowMs, max, message }) {
  const hits = new Map(); // ip -> { count, resetAt }
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) if (entry.resetAt <= now) hits.delete(ip);
  }, Math.min(windowMs, 60 * 1000)).unref();

  return function limiter(req, res, next) {
    if (process.env.RATE_LIMIT === 'off') return next();
    const now = Date.now();
    let entry = hits.get(req.ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(req.ip, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: message || 'Too many requests. Please wait a little and try again.' });
    }
    next();
  };
}

module.exports = rateLimit;
