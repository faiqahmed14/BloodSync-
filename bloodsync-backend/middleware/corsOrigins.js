// CORS_ORIGINS lists the website addresses allowed to call the API from a browser.
//   CORS_ORIGINS=https://bloodsync.vercel.app
//   CORS_ORIGINS=https://bloodsync.vercel.app,https://bloodsync-*-myteam.vercel.app
// An entry may contain * which stands for ONE chunk of letters, digits and hyphens, so Vercel's
// preview addresses (bloodsync-git-main-myteam.vercel.app and so on) can be allowed with one entry.
// Leave it unset and any website may call the API (fine for development).
// It is read on every request, so it can be changed without touching the code.
function compile(list) {
  const exact = new Set();
  const patterns = [];
  for (const raw of list) {
    const entry = raw.replace(/\/+$/, '');
    if (entry.includes('*')) {
      const re = entry.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+');
      patterns.push(new RegExp(`^${re}$`, 'i'));
    } else {
      exact.add(entry.toLowerCase());
    }
  }
  return (origin) => exact.has(origin.toLowerCase()) || patterns.some((p) => p.test(origin));
}

function isAllowed(origin, envValue = process.env.CORS_ORIGINS) {
  const list = (envValue || '').split(',').map((o) => o.trim()).filter(Boolean);
  if (!list.length) return true;   // not configured: allow everyone
  if (!origin) return true;        // not a browser cross-site call (curl, same-origin, health checks)
  return compile(list)(origin);
}

// The function shape both `cors` and Socket.io accept: (origin, callback).
function corsOriginCheck(origin, callback) {
  callback(null, isAllowed(origin));
}

module.exports = { isAllowed, corsOriginCheck };
