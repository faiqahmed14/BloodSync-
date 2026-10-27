const express = require('express');
const router = express.Router();

// GET /api/config: public settings the frontend needs.
//  - vapidPublicKey: served from here so the browser can never drift out of sync with the
//    key the server signs push messages with (a mismatch makes every push silently fail).
//  - mapProvider: "osm" (the default and free: Leaflet + OpenFreeMap, no key, no card, English labels)
//    or "google" (opt-in with MAP_PROVIDER=google; needs a Google Cloud billing account).
//  - googleMapsApiKey / googleMapsMapId: only sent when the provider is "google". Browser keys are
//    public by nature, so restrict that key to your website's address in Google Cloud.
router.get('/', (req, res) => {
  const google = process.env.MAP_PROVIDER === 'google';
  res.json({
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
    mapProvider: google ? 'google' : 'osm',
    googleMapsApiKey: google ? process.env.GOOGLE_MAPS_API_KEY || null : null,
    googleMapsMapId: google ? process.env.GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID' : null
  });
});

module.exports = router;
