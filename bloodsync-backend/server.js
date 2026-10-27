require('dotenv').config();
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const errorHandler = require('./middleware/errorHandler');
const rateLimit = require('./middleware/rateLimit');
const { corsOriginCheck } = require('./middleware/corsOrigins');
const { initSockets } = require('./sockets');
const { startWaveTimeoutChecker } = require('./jobs/waveTimeoutChecker');
const { startCooldownRelease } = require('./jobs/cooldownRelease');

const donorRoutes = require('./routes/donors');
const requestRoutes = require('./routes/requests');
const boardRoutes = require('./routes/board');
const routeRoutes = require('./routes/route');
const configRoutes = require('./routes/config');
const statsRoutes = require('./routes/stats');

const app = express();
const httpServer = http.createServer(app);
const isProduction = () => process.env.NODE_ENV === 'production';

app.disable('x-powered-by');
// Behind Render / Railway / Fly / nginx the visitor's real address and protocol arrive in
// X-Forwarded-* headers. Without this the rate limiter would treat everyone as one visitor.
app.set('trust proxy', 1);

// CORS: unset = any origin (fine for development). In production set CORS_ORIGINS to your site
// (wildcards such as https://bloodsync-*-myteam.vercel.app are supported, see middleware/corsOrigins.js).
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
app.use(cors({ origin: corsOriginCheck }));

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()'
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
});

// Geolocation, push notifications and the service worker only work over HTTPS. If a platform
// terminates TLS in front of us and someone arrives over plain http, send them to https
// (health checks are exempt so the platform's own probe keeps working).
app.use((req, res, next) => {
  const isProbe = req.path === '/api/health' || req.path === '/healthz';
  if (isProduction() && process.env.FORCE_HTTPS !== 'false' && !isProbe && req.get('x-forwarded-proto') === 'http') {
    return res.redirect(301, `https://${req.get('host')}${req.originalUrl}`);
  }
  next();
});

app.use(express.json({ limit: '50kb' }));

const health = (req, res) => {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  res.json({ status: 'ok', database: states[mongoose.connection.readyState] || 'unknown', uptimeSeconds: Math.round(process.uptime()) });
};
app.get('/api/health', health);
app.get('/healthz', health);

// Abuse protection. Creating a donor or an emergency request is limited per visitor; everything
// else gets a generous ceiling. (Mobile networks often share one address between many people,
// so the numbers are deliberately not tight.)
app.use('/api', rateLimit({ windowMs: 5 * 60 * 1000, max: 3000 }));
const createRequestLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, message: 'Too many requests were created from this connection. Please wait a few minutes.' });
const createDonorLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, message: 'Too many registrations from this connection. Please try again later.' });
app.use('/api/requests', (req, res, next) => (req.method === 'POST' && req.path === '/' ? createRequestLimit(req, res, next) : next()));
app.use('/api/donors', (req, res, next) => (req.method === 'POST' && req.path === '/' ? createDonorLimit(req, res, next) : next()));

app.use('/api/donors', donorRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/board', boardRoutes);
app.use('/api/route', routeRoutes);
app.use('/api/config', configRoutes);
app.use('/api', statsRoutes);

// Unknown API paths get a JSON 404 instead of falling through to the static files.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Serve the website from the same server, so one `npm start` runs everything at
// http://localhost:4000: same origin as the API (no CORS), and sw.js can be served
// from the site root, which push notifications require.
// Caching: pages, scripts, the service worker and the manifest are always revalidated, otherwise
// visitors (and the service worker) keep running the OLD version for hours after a redeploy.
app.use(express.static(path.join(__dirname, '..', 'bloodsync-frontend'), {
  setHeaders(res, filePath) {
    if (/\.(png|svg|jpg|jpeg|webp|ico)$/i.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=86400');
    else res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.use(errorHandler);

const PORT = process.env.PORT || 4000;

// Never let a stray rejected promise take the whole server down silently.
process.on('unhandledRejection', (reason) => console.error('Unhandled promise rejection:', reason));

connectDB()
  .then(() => {
    initSockets(httpServer);
    startWaveTimeoutChecker();
    startCooldownRelease();
    httpServer.listen(PORT, () => {
      console.log(`BloodSync running on port ${PORT}`);
      console.log(`  Website + API: http://localhost:${PORT}`);
      if (process.env.MAP_PROVIDER === 'google' && !process.env.GOOGLE_MAPS_API_KEY) {
        console.warn('  ! MAP_PROVIDER=google but GOOGLE_MAPS_API_KEY is not set in .env, so maps will show a setup message.');
      }
      if (isProduction() && !corsOrigins.length) {
        console.warn('  ! CORS_ORIGINS is not set: the API accepts requests from any website. Set it to your site address.');
      }
    });
  })
  .catch((err) => {
    console.error('Failed to start:', err.message);
    if (err.hint) console.error(`  Hint: ${err.hint}`);
    process.exit(1);
  });

// Hosting platforms send SIGTERM on every redeploy: finish quietly instead of dropping connections.
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  httpServer.close(() => mongoose.connection.close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
