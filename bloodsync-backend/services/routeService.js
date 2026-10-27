// Shortest-route lookup used by both the donor's map and the requester's tracking map.
//
// Provider order (first one that works wins):
//   1. Google Routes API: ONLY when MAP_PROVIDER=google and a key is set (it needs a Google
//      Cloud billing account). Enable "Routes API" for the project. Called from the server so
//      the browser never needs access to it.
//   2. OSRM (OpenStreetMap routing): free public demo server, no key needed. This is the default.
//   3. A straight line, so the map never goes blank.
// The response says which one was used via `source`: "google" | "osrm" | "straight-line".

const OSRM_BASE_URL = (process.env.OSRM_BASE_URL || 'https://router.project-osrm.org').replace(/\/$/, '');
const GOOGLE_ROUTES_URL = process.env.GOOGLE_ROUTES_URL || 'https://routes.googleapis.com/directions/v2:computeRoutes';
const TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 15 * 1000;
const CACHE_MAX = 300;
const FALLBACK_KMH = 22; // same city-traffic assumption the matching ETA uses

const cache = new Map();

function haversineMeters([lng1, lat1], [lng2, lat2]) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function straightLine(from, to) {
  const distanceMeters = Math.round(haversineMeters(from, to));
  return {
    source: 'straight-line',
    shortest: {
      distanceMeters,
      durationSeconds: Math.round((distanceMeters / 1000 / FALLBACK_KMH) * 3600),
      coordinates: [from, to]
    },
    alternatives: []
  };
}

function simplify(route) {
  return {
    distanceMeters: Math.round(route.distance),
    durationSeconds: Math.round(route.duration),
    coordinates: route.geometry.coordinates // [[lng, lat], ...]
  };
}

// Google returns each route's path as an "encoded polyline" string; this turns it back
// into [[lng, lat], ...] (the same shape the OSRM provider returns).
function decodePolyline(encoded) {
  const coords = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    for (const axis of ['lat', 'lng']) {
      let result = 0, shift = 0, byte;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 'lat') lat += delta; else lng += delta;
    }
    coords.push([lng / 1e5, lat / 1e5]);
  }
  return coords;
}

function pickShortest(routes, source) {
  let shortestIdx = 0;
  routes.forEach((r, i) => {
    if (r.distanceMeters < routes[shortestIdx].distanceMeters) shortestIdx = i;
  });
  return { source, shortest: routes[shortestIdx], alternatives: routes.filter((_, i) => i !== shortestIdx) };
}

let warnedGoogle = false;
async function googleRoute(from, to) {
  if (process.env.MAP_PROVIDER !== 'google') return null; // free default: skip Google entirely
  const key = process.env.GOOGLE_ROUTES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;

  const point = ([lng, lat]) => ({ location: { latLng: { latitude: lat, longitude: lng } } });
  const res = await fetch(GOOGLE_ROUTES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      // Ask only for what we use, keeps the response small and the request in the cheapest tier.
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline'
    },
    body: JSON.stringify({
      origin: point(from),
      destination: point(to),
      travelMode: 'DRIVE',
      routingPreference: process.env.GOOGLE_ROUTES_TRAFFIC === 'true' ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE',
      computeAlternativeRoutes: true,
      polylineQuality: 'HIGH_QUALITY',
      polylineEncoding: 'ENCODED_POLYLINE'
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error.message; } catch (_) { /* no body */ }
    throw new Error(`Google Routes API answered ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const data = await res.json();
  if (!data.routes || data.routes.length === 0) throw new Error('Google found no route');

  // Google's first route is the default (fastest). The app wants the SHORTEST, so among the
  // alternatives pick the smallest distance.
  const routes = data.routes
    .filter((r) => r.polyline && r.polyline.encodedPolyline)
    .map((r) => ({
      distanceMeters: Math.round(r.distanceMeters || 0),
      durationSeconds: Math.round(parseFloat(r.duration) || 0), // "765s" -> 765
      coordinates: decodePolyline(r.polyline.encodedPolyline)
    }));
  if (routes.length === 0) throw new Error('Google returned no route geometry');
  return pickShortest(routes, 'google');
}

async function osrmRoute(from, to) {
  const url =
    `${OSRM_BASE_URL}/route/v1/driving/${from[0]},${from[1]};${to[0]},${to[1]}` +
    `?overview=full&geometries=geojson&alternatives=true&steps=false`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`routing service answered ${res.status}`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
    throw new Error(`no route found (${data.code})`);
  }
  return pickShortest(data.routes.map(simplify), 'osrm');
}

async function getRoute(from, to) {
  const key = [...from, ...to].map((n) => n.toFixed(4)).join(',');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let value = null;
  try {
    value = await googleRoute(from, to);
  } catch (err) {
    if (!warnedGoogle) {
      console.warn(`Google Routes failed (${err.message}). Falling back to OSRM. Is the "Routes API" enabled for your key?`);
      warnedGoogle = true;
    }
  }
  if (!value) {
    try {
      value = await osrmRoute(from, to);
    } catch (err) {
      console.warn(`Route lookup failed, using straight line: ${err.message}`);
      value = straightLine(from, to);
    }
  }

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
  return value;
}

module.exports = { getRoute, haversineMeters, decodePolyline };
