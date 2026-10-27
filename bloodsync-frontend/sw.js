// This file must be served from the same origin as the frontend, at the
// site's root (e.g. https://your-domain.com/sw.js), for push notifications
// and notification clicks to work. It cannot run from a file:// URL, the
// site needs to actually be deployed (or run on localhost) over http/https.
// (Running `npm start` in bloodsync-backend serves everything correctly.)

// Take over from an older version of this worker straight away.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { body: event.data ? event.data.text() : '' };
  }

  const isNewRequest = data.type === 'new-request';
  const title = data.title || 'BloodSync';
  const options = {
    body: data.body || 'Someone nearby needs blood.',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    // Same tag => a later "cancelled" / "filled" message REPLACES the original alert
    // instead of piling up next to it.
    tag: data.tag || (data.requestId ? `request-${data.requestId}` : 'bloodsync'),
    renotify: true,
    // New-request alerts stay on screen until the donor reacts to them.
    requireInteraction: isNewRequest,
    vibrate: isNewRequest ? [300, 120, 300, 120, 300] : [150],
    data: { requestId: data.requestId, type: data.type }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { requestId, type } = event.notification.data || {};

  const base = new URL('./', self.registration.scope);
  const target = new URL(base);
  if (requestId && type === 'new-request') target.searchParams.set('requestId', requestId);
  target.hash = 'donate';

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Reuse a tab that already has BloodSync open rather than opening a duplicate.
      const existing = windows.find((w) => w.url.startsWith(base.href));
      if (existing) {
        await existing.focus();
        existing.postMessage({ type: 'open-request', requestId: type === 'new-request' ? requestId : null });
        return;
      }
      await self.clients.openWindow(target.href);
    })()
  );
});
