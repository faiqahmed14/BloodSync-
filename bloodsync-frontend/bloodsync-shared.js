/* BloodSync: helpers shared by index.html (donor + requester) and tracking.html.
 * Exposes one global: window.BloodSync
 */
(function (global) {
  'use strict';

  // ---------- Where is the backend? ----------
  // 1. window.BLOODSYNC_API_BASE, if you set it before this file loads (e.g. a separate
  //    frontend host that talks to a deployed backend such as Render).
  // 2. Opened as a local file -> http://localhost:4000
  // 3. Served by the backend itself (http://localhost:4000, or any deployed domain) -> same origin.
  // 4. Served by something else on localhost (e.g. VS Code Live Server :5500) -> http://localhost:4000
  function resolveApiBase() {
    if (global.BLOODSYNC_API_BASE) return String(global.BLOODSYNC_API_BASE).replace(/\/$/, '');
    const { protocol, hostname, port, origin } = global.location;
    if (protocol !== 'http:' && protocol !== 'https:') return 'http://localhost:4000';
    const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
    if (!isLocal) return origin;
    return port === '4000' ? origin : 'http://localhost:4000';
  }
  const API_BASE = resolveApiBase();

  // ---------- Small utilities ----------
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  // Everything a user typed (patient name, notes, hospital...) is shown to OTHER people,
  // so it must always be escaped before going into innerHTML.
  function esc(value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (c) => ESC[c]);
  }

  function telHref(phone) {
    return 'tel:' + String(phone || '').replace(/[^\d+]/g, '');
  }
  function waHref(phone) {
    let d = String(phone || '').replace(/\D/g, '');
    if (d.startsWith('0')) d = '92' + d.slice(1);
    else if (!d.startsWith('92')) d = '92' + d;
    return 'https://wa.me/' + d;
  }
  function mapsLink(lat, lng) {
    return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
  }

  function fmtDistance(meters) {
    if (!Number.isFinite(meters)) return 'N/A';
    return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
  }
  function fmtDuration(seconds) {
    if (!Number.isFinite(seconds)) return 'N/A';
    const min = Math.max(1, Math.round(seconds / 60));
    if (min < 60) return `${min} min`;
    return `${Math.floor(min / 60)} h ${min % 60} min`;
  }
  function haversineMeters([lng1, lat1], [lng2, lat2]) {
    const R = 6371000;
    const rad = (d) => (d * Math.PI) / 180;
    const a =
      Math.sin(rad(lat2 - lat1) / 2) ** 2 +
      Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function validCoords(c) {
    return Array.isArray(c) && c.length === 2 && c.every((n) => typeof n === 'number' && isFinite(n));
  }

  // ---------- API wrapper ----------
  // Distinguishes "the server could not be reached" (err.network === true) from "the
  // server answered with an error" (err.status set), so screens never claim the backend
  // is down when it isn't.
  class ApiError extends Error {
    constructor(message, { status = 0, network = false } = {}) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.network = network;
    }
  }

  // Free hosting plans put the server to sleep when nobody has used it for a while, and waking it
  // takes 30 to 60 seconds. Without handling, every first visit looked like "could not reach the
  // server". So: a visible "waking up" notice after 4 s, safe reads (GET) are retried automatically,
  // and writes get a long timeout instead of being retried (a retry could create a duplicate request).
  let wakeBanner = null;
  let pending = 0;
  function showWake() {
    if (wakeBanner) return;
    wakeBanner = document.createElement('div');
    wakeBanner.setAttribute('role', 'status');
    wakeBanner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10002;background:#c9a227;color:#14181c;text-align:center;padding:9px 14px;font:600 .85rem Inter,Arial,sans-serif';
    wakeBanner.textContent = 'Waking up the server. On free hosting this can take up to a minute the first time. Thanks for waiting.';
    document.body.appendChild(wakeBanner);
  }
  function hideWake() { if (wakeBanner && pending === 0) { wakeBanner.remove(); wakeBanner = null; } }

  async function api(path, { method = 'GET', body, timeoutMs } = {}) {
    const isRead = method === 'GET';
    const limit = timeoutMs || (isRead ? 25000 : 60000);
    const tries = isRead ? 3 : 1;
    pending++;
    const wakeTimer = setTimeout(() => { if (document.body) showWake(); }, 4000);
    try {
      let res = null, lastErr = null;
      for (let attempt = 1; attempt <= tries && !res; attempt++) {
        try {
          res = await fetch(API_BASE + path, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout ? AbortSignal.timeout(limit) : undefined
          });
        } catch (err) {
          lastErr = err;
          if (attempt < tries) await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
      if (!res) throw new ApiError(`Could not reach the BloodSync server at ${API_BASE}. Is it running?`, { network: true });

      let data = null;
      try { data = await res.json(); } catch (_) { /* non-JSON body */ }
      if (!res.ok) {
        const detail = data && data.details && typeof data.details === 'string' ? `: ${data.details}` : '';
        throw new ApiError(((data && data.error) || `Request failed (${res.status})`) + detail, { status: res.status });
      }
      return data;
    } finally {
      clearTimeout(wakeTimer);
      pending--;
      hideWake();
    }
  }

  // ---------- Live updates (Socket.io) ----------
  // The browser library is loaded from YOUR server (/socket.io/socket.io.js), so its version always
  // matches the server and no third-party CDN is needed (CDNs can be blocked on some networks).
  // The CDN is only a fallback. You can call on()/emit() immediately; calls made before the library
  // has loaded are replayed as soon as it has.
  function createSocket() {
    const queue = [];
    let real = null;
    const proxy = {
      on(...args) { if (real) real.on(...args); else queue.push(['on', args]); return proxy; },
      emit(...args) { if (real) real.emit(...args); else queue.push(['emit', args]); return proxy; },
      get connected() { return !!(real && real.connected); },
      get io() { return real ? real.io : undefined; }
    };
    (async () => {
      try {
        await loadScript(API_BASE + '/socket.io/socket.io.js');
      } catch (_) {
        try { await loadScript('https://cdn.socket.io/4.8.1/socket.io.min.js'); }
        catch (__) { console.warn('Live updates are unavailable (socket.io could not be loaded). The page falls back to refreshing itself.'); return; }
      }
      real = global.io(API_BASE);
      queue.forEach(([method, args]) => real[method](...args));
      queue.length = 0;
    })();
    return proxy;
  }

  // ---------- "My requests" (kept in this browser only) ----------
  // The secret token that allows cancelling is stored here, in the browser that created
  // the request: nobody else can cancel it.
  const MINE_KEY = 'bloodsync_my_requests';
  const ACTIVE_KEY = 'bloodsync_active_request';
  function readMine() {
    try { return JSON.parse(localStorage.getItem(MINE_KEY)) || {}; } catch (_) { return {}; }
  }
  function saveMyRequest(id, token) {
    try {
      const mine = readMine();
      mine[id] = { token, savedAt: Date.now() };
      localStorage.setItem(MINE_KEY, JSON.stringify(mine));
      localStorage.setItem(ACTIVE_KEY, id);
    } catch (_) { /* storage unavailable */ }
  }
  function getMyToken(id) {
    const entry = readMine()[id];
    return entry ? entry.token : null;
  }
  function getActiveRequestId() {
    try { return localStorage.getItem(ACTIVE_KEY); } catch (_) { return null; }
  }
  function clearActiveRequest(id) {
    try { if (!id || localStorage.getItem(ACTIVE_KEY) === id) localStorage.removeItem(ACTIVE_KEY); } catch (_) {}
  }

  // ---------- Maps ----------
  // Two providers share one interface (createMap -> addMarker / showRoute / fitRoute ...):
  //   - "osm" (default): free Leaflet + OpenFreeMap, English labels. Nothing to configure.
  //   - "google": Google Maps, opt-in with MAP_PROVIDER=google in .env.
  // For Google, the API key comes from the server (GET /api/config <- GOOGLE_MAPS_API_KEY in .env), so it is
  // never hard-coded in the page. Everything Google-specific is wrapped in the BSMap class below,
  // so the pages just say "add a marker here" / "show this route".
  function injectStyle(css, id) {
    if (document.getElementById(id)) return;
    const el = document.createElement('style');
    el.id = id;
    el.textContent = css;
    document.head.appendChild(el);
  }
  injectStyle(
    `@keyframes bs-pulse{0%{box-shadow:0 0 0 0 rgba(27,138,107,.55)}100%{box-shadow:0 0 0 14px rgba(27,138,107,0)}}
     .bs-donor-dot{width:16px;height:16px;border-radius:50%;background:#1b8a6b;border:2px solid #fff;animation:bs-pulse 1.6s infinite}
     .bs-you-dot{width:16px;height:16px;border-radius:50%;background:#2d6cdf;border:2px solid #fff;box-shadow:0 0 0 4px rgba(45,108,223,.25)}
     .bs-hospital{width:30px;height:30px;border-radius:8px;background:#d6302b;color:#fff;font:700 18px/30px Arial,sans-serif;text-align:center;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4)}
     .bs-map-msg{height:100%;min-height:120px;display:flex;align-items:center;justify-content:center;text-align:center;padding:22px;font:.9rem/1.5 Inter,Arial,sans-serif;color:#5b6472;background:#ece7dc}
     .bs-map-msg b{display:block;margin-bottom:6px;color:#14181c}
     .bs-map-msg code{background:rgba(0,0,0,.08);padding:1px 5px;border-radius:4px;font-size:.85em}`,
    'bs-shared-map-css'
  );

  class MapError extends Error {
    constructor(code) { super(code); this.name = 'MapError'; this.code = code; }
  }

  let mapsPromise = null;
  let mapId = 'DEMO_MAP_ID';
  const authListeners = [];
  let authFailed = false;
  // Google calls this global if it rejects the key (wrong key, billing off, API not enabled,
  // or the key is restricted to a different website address).
  global.gm_authFailure = () => { authFailed = true; authListeners.forEach((fn) => fn()); };

  let configPromise = null;
  function getConfig() {
    if (!configPromise) { configPromise = api('/api/config'); configPromise.catch(() => { configPromise = null; }); }
    return configPromise;
  }

  function loadGoogleMaps() {
    if (mapsPromise) return mapsPromise;
    mapsPromise = (async () => {
      const config = await getConfig();
      if (!config.googleMapsApiKey) throw new MapError('NO_KEY');
      mapId = config.googleMapsMapId || 'DEMO_MAP_ID';
      await new Promise((resolve, reject) => {
        global.__bsMapsReady = resolve;
        const tag = document.createElement('script');
        tag.async = true;
        tag.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(config.googleMapsApiKey) +
          '&v=weekly&loading=async&libraries=marker&callback=__bsMapsReady';
        tag.onerror = () => reject(new MapError('LOAD_FAILED'));
        document.head.appendChild(tag);
      });
      await global.google.maps.importLibrary('maps');
      await global.google.maps.importLibrary('marker');
    })();
    mapsPromise.catch(() => { mapsPromise = null; }); // allow a retry on the next call
    return mapsPromise;
  }

  const MAP_MESSAGES = {
    NO_KEY: '<b>Google Maps isn’t set up yet</b>Add your key as <code>GOOGLE_MAPS_API_KEY</code> in <code>bloodsync-backend/.env</code> and restart the server.',
    LOAD_FAILED: '<b>The map couldn’t load</b>The map needs an internet connection. Everything else still works.',
    AUTH: '<b>Google rejected the map key</b>Check that billing is on, that the <i>Maps JavaScript API</i> is enabled, and that the key allows this website address.'
  };
  // Puts a readable message in place of a map that couldn't be shown.
  function showMapError(el, err) {
    console.warn('Map unavailable:', err && (err.code || err.message));
    el.innerHTML = `<div class="bs-map-msg"><div>${MAP_MESSAGES[(err && err.code) || 'LOAD_FAILED'] || MAP_MESSAGES.LOAD_FAILED}</div></div>`;
  }

  const MARKER_HTML = {
    hospital: '<div class="bs-hospital">+</div>',
    donor: '<div class="bs-donor-dot"></div>',
    you: '<div class="bs-you-dot"></div>'
  };

  class BSMap {
    constructor(el, map) {
      this.el = el;
      this.map = map;
      this._markers = [];
      this._lines = [];
      this._bounds = null;
      this._needFit = false;
      // A map created inside a hidden section has no size; when it becomes visible, tell Google
      // to re-measure and (if a fit was requested while hidden) re-frame the route.
      if (global.ResizeObserver) {
        this._ro = new ResizeObserver(() => {
          if (el.clientWidth > 0 && el.clientHeight > 0) {
            global.google.maps.event.trigger(map, 'resize');
            if (this._needFit) this.fitRoute();
          }
        });
        this._ro.observe(el);
      }
      authListeners.push(() => showMapError(el, new MapError('AUTH')));
      if (authFailed) showMapError(el, new MapError('AUTH'));
    }

    // Positions are always [lng, lat] (the same order the API uses).
    setView([lng, lat], zoom) {
      this.map.setCenter({ lat, lng });
      if (zoom) this.map.setZoom(zoom);
    }

    addMarker(kind, [lng, lat], { infoHtml, title } = {}) {
      const content = document.createElement('div');
      content.style.transform = 'translate(0, 50%)'; // centre the marker on its point (default anchors the bottom edge)
      content.innerHTML = MARKER_HTML[kind];
      const marker = new global.google.maps.marker.AdvancedMarkerElement({
        map: this.map, position: { lat, lng }, content, title: title || ''
      });
      if (infoHtml) {
        const info = new global.google.maps.InfoWindow({ content: infoHtml });
        content.addEventListener('click', () => info.open({ anchor: marker, map: this.map }));
      }
      let pos = [lng, lat];
      const handle = {
        el: content,
        setPosition: ([x, y]) => { pos = [x, y]; marker.position = { lat: y, lng: x }; },
        getPosition: () => pos,
        remove: () => { marker.map = null; this._markers = this._markers.filter((m) => m !== handle); }
      };
      this._markers.push(handle);
      return handle;
    }

    clearMarkers() { [...this._markers].forEach((m) => m.remove()); }

    // Draws every alternative faintly (grey dashes) and the SHORTEST route boldly on top
    // (white casing + red line) so it clearly stands out. A straight-line fallback is dotted.
    showRoute(route) {
      const g = global.google.maps;
      this.clearRoute();
      const path = (coords) => coords.map(([lng, lat]) => ({ lat, lng }));
      (route.alternatives || []).forEach((alt) => {
        this._lines.push(new g.Polyline({
          map: this.map, path: path(alt.coordinates), strokeOpacity: 0, zIndex: 1,
          icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.8, strokeColor: '#8b93a1', scale: 3 }, offset: '0', repeat: '14px' }]
        }));
      });
      const main = path(route.shortest.coordinates);
      this._lines.push(new g.Polyline({ map: this.map, path: main, strokeColor: '#ffffff', strokeOpacity: 0.95, strokeWeight: 10, zIndex: 2 }));
      const straight = route.source === 'straight-line';
      this._lines.push(new g.Polyline({
        map: this.map, path: main, strokeColor: '#d6302b', zIndex: 3, strokeWeight: 6,
        strokeOpacity: straight ? 0 : 0.95,
        icons: straight ? [{ icon: { path: g.SymbolPath.CIRCLE, scale: 2.5, strokeColor: '#d6302b', strokeOpacity: 1, fillColor: '#d6302b', fillOpacity: 1 }, offset: '0', repeat: '12px' }] : undefined
      }));
      const bounds = new g.LatLngBounds();
      main.forEach((p) => bounds.extend(p));
      this._bounds = bounds;
    }

    clearRoute() { this._lines.forEach((l) => l.setMap(null)); this._lines = []; }

    fitRoute(padding = 50) {
      if (!this._bounds) return;
      if (!(this.el.clientWidth > 0 && this.el.clientHeight > 0)) { this._needFit = true; return; } // hidden: do it once shown
      this._needFit = false;
      this.map.fitBounds(this._bounds, padding);
    }

    // Is this point inside the part of the map the user can currently see?
    isVisible([lng, lat]) {
      const b = this.map.getBounds();
      return b ? b.contains({ lat, lng }) : true;
    }

    // Soft "searching" ring around a point; returns an object you can resize/remove.
    addPulse([lng, lat], radiusMeters) {
      const circle = new global.google.maps.Circle({
        map: this.map, center: { lat, lng }, radius: radiusMeters,
        strokeColor: '#c9a227', strokeWeight: 1, fillColor: '#c9a227', fillOpacity: 0.08
      });
      return { getRadius: () => circle.getRadius(), setRadius: (r) => circle.setRadius(r), remove: () => circle.setMap(null) };
    }
  }

  // ---------- Free maps: Leaflet + OpenFreeMap (the default) ----------
  // No API key, no account, no credit card. OpenFreeMap serves vector tiles; they are drawn by
  // MapLibre GL inside a normal Leaflet map. Library versions are pinned on purpose.
  const LEAFLET_VER = '1.9.4', MAPLIBRE_VER = '4.7.1', MLL_VER = '0.1.4';
  const OPENFREEMAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
  const OSM_RASTER = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'; // fallback only (local-language labels)

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = src; tag.async = false;
      tag.onload = resolve; tag.onerror = () => reject(new Error('could not load ' + src));
      document.head.appendChild(tag);
    });
  }
  function loadCss(href) {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = href;
    document.head.appendChild(link);
  }

  // Every label in the style becomes the English name where OpenStreetMap has one, else the
  // Latin-script (transliterated) name, else the local name. Without this, labels follow the
  // local language (for example Urdu script in Pakistan).
  const ENGLISH_LABEL = ['coalesce', ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name']];
  function englishLabels(style) {
    (style.layers || []).forEach((layer) => {
      const textField = layer.layout && layer.layout['text-field'];
      if (textField !== undefined && JSON.stringify(textField).indexOf('name') !== -1) {
        layer.layout['text-field'] = ENGLISH_LABEL; // road numbers ("{ref}"), house numbers etc. are left alone
      }
    });
    return style;
  }

  let leafletPromise = null;
  function loadLeaflet() {
    if (leafletPromise) return leafletPromise;
    leafletPromise = (async () => {
      if (!global.L) {
        loadCss(`https://unpkg.com/leaflet@${LEAFLET_VER}/dist/leaflet.css`);
        await loadScript(`https://unpkg.com/leaflet@${LEAFLET_VER}/dist/leaflet.js`);
      }
    })();
    leafletPromise.catch(() => { leafletPromise = null; });
    return leafletPromise;
  }

  // Adds the English OpenFreeMap basemap to a Leaflet map. If anything about the vector map is
  // unavailable (no WebGL, blocked CDN, OpenFreeMap down) it falls back to plain OpenStreetMap
  // tiles so the map is never blank, those show names in the local language.
  async function addBasemap(map) {
    try {
      const canvas = document.createElement('canvas');
      if (!(canvas.getContext('webgl2') || canvas.getContext('webgl'))) throw new Error('WebGL is not available');
      if (!global.maplibregl) {
        loadCss(`https://unpkg.com/maplibre-gl@${MAPLIBRE_VER}/dist/maplibre-gl.css`);
        await loadScript(`https://unpkg.com/maplibre-gl@${MAPLIBRE_VER}/dist/maplibre-gl.js`);
      }
      if (!(global.L && global.L.maplibreGL)) {
        await loadScript(`https://unpkg.com/@maplibre/maplibre-gl-leaflet@${MLL_VER}/leaflet-maplibre-gl.js`);
      }
      const res = await fetch(OPENFREEMAP_STYLE);
      if (!res.ok) throw new Error('style answered ' + res.status);
      const style = englishLabels(await res.json());
      global.L.maplibreGL({ style }).addTo(map);
      map.attributionControl.addAttribution(
        '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' +
        '&copy; <a href="https://openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> ' +
        'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>');
    } catch (err) {
      console.warn('English vector map unavailable, using plain OpenStreetMap tiles:', err.message);
      global.L.tileLayer(OSM_RASTER, { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
    }
  }

  const MARKER_SIZE = { hospital: 30, donor: 16, you: 16 };

  // Same interface as BSMap (Google), so the pages don't care which one they got.
  class LeafletBSMap {
    constructor(el, map) {
      this.el = el; this.map = map;
      this._markers = []; this._lines = null; this._bounds = null; this._needFit = false;
      this._lines = global.L.layerGroup().addTo(map);
      if (global.ResizeObserver) {
        this._ro = new ResizeObserver(() => {
          if (el.clientWidth > 0 && el.clientHeight > 0) {
            map.invalidateSize();
            if (this._needFit) this.fitRoute();
          }
        });
        this._ro.observe(el);
      }
    }

    setView([lng, lat], zoom) { this.map.setView([lat, lng], zoom || this.map.getZoom()); }

    addMarker(kind, [lng, lat], { infoHtml, title } = {}) {
      const size = MARKER_SIZE[kind];
      const marker = global.L.marker([lat, lng], {
        title: title || '',
        icon: global.L.divIcon({ html: MARKER_HTML[kind], iconSize: [size, size], iconAnchor: [size / 2, size / 2], className: '' })
      }).addTo(this.map);
      if (infoHtml) marker.bindPopup(infoHtml);
      const handle = {
        el: marker.getElement(),
        setPosition: ([x, y]) => marker.setLatLng([y, x]),
        getPosition: () => { const p = marker.getLatLng(); return [p.lng, p.lat]; },
        remove: () => { marker.remove(); this._markers = this._markers.filter((m) => m !== handle); }
      };
      this._markers.push(handle);
      return handle;
    }

    clearMarkers() { [...this._markers].forEach((m) => m.remove()); }

    // Alternatives faint (grey dashes); the SHORTEST route bold red on a white casing.
    showRoute(route) {
      const L = global.L;
      this.clearRoute();
      const pts = (coords) => coords.map(([lng, lat]) => [lat, lng]);
      (route.alternatives || []).forEach((alt) => {
        L.polyline(pts(alt.coordinates), { color: '#8b93a1', weight: 4, opacity: 0.7, dashArray: '6 8' }).addTo(this._lines);
      });
      const main = pts(route.shortest.coordinates);
      L.polyline(main, { color: '#ffffff', weight: 10, opacity: 0.9 }).addTo(this._lines);
      const line = L.polyline(main, {
        color: '#d6302b', weight: 6, opacity: 0.95, dashArray: route.source === 'straight-line' ? '2 10' : null
      }).addTo(this._lines);
      this._bounds = line.getBounds();
    }

    clearRoute() { this._lines.clearLayers(); }

    fitRoute(padding = 50) {
      if (!this._bounds) return;
      if (!(this.el.clientWidth > 0 && this.el.clientHeight > 0)) { this._needFit = true; return; } // hidden: do it once shown
      this._needFit = false;
      this.map.fitBounds(this._bounds, { padding: [padding, padding] });
    }

    isVisible([lng, lat]) { return this.map.getBounds().contains([lat, lng]); }

    addPulse([lng, lat], radiusMeters) {
      const circle = global.L.circle([lat, lng], { radius: radiusMeters, color: '#c9a227', fillColor: '#c9a227', fillOpacity: 0.08, weight: 1 }).addTo(this.map);
      return { getRadius: () => circle.getRadius(), setRadius: (r) => circle.setRadius(r), remove: () => circle.remove() };
    }
  }

  async function createLeafletMap(el, { center, zoom }) {
    try { await loadLeaflet(); } catch (_) { throw new MapError('LOAD_FAILED'); }
    const map = global.L.map(el, { center: [center[1], center[0]], zoom });
    await addBasemap(map);
    return new LeafletBSMap(el, map);
  }

  // Creates a map inside `el` using whichever provider the server is configured for
  // (free Leaflet/OpenFreeMap by default; Google Maps if MAP_PROVIDER=google).
  // Rejects with a MapError (code NO_KEY | LOAD_FAILED) if no map can be shown.
  async function createMap(el, opts) {
    const config = await getConfig();
    if (config.mapProvider === 'google') return createGoogleMap(el, opts);
    return createLeafletMap(el, opts);
  }

  async function createGoogleMap(el, { center, zoom }) {
    await loadGoogleMaps();
    const map = new global.google.maps.Map(el, {
      center: { lat: center[1], lng: center[0] }, zoom, mapId,
      mapTypeControl: false, streetViewControl: false, fullscreenControl: true, clickableIcons: false
    });
    return new BSMap(el, map);
  }

  // GET /api/route -> { source, shortest, alternatives }
  function fetchRoute(from, to) {
    return api(`/api/route?from=${from[0]},${from[1]}&to=${to[0]},${to[1]}`);
  }

  // ---------- "Cancel My Request" dialog ----------
  const CANCEL_REASON_LABELS = {
    'donor-not-found': 'No donor was found',
    'arranged-locally': 'Blood was arranged locally (hospital, blood bank, family or friends)',
    'no-longer-needed': 'The blood is no longer needed',
    other: 'Another reason'
  };

  injectStyle(
    `.bs-modal-backdrop{position:fixed;inset:0;background:rgba(10,12,14,.72);z-index:10000;display:flex;align-items:center;justify-content:center;padding:18px}
     .bs-modal{background:#1c2127;color:#f1ede6;border:1px solid rgba(241,237,230,.14);border-radius:12px;max-width:460px;width:100%;padding:26px;font-family:Inter,Arial,sans-serif;max-height:92vh;overflow:auto}
     .bs-modal h3{font-size:1.2rem;margin-bottom:6px}
     .bs-modal p.sub{color:#8b93a1;font-size:.88rem;margin-bottom:16px}
     .bs-reason{display:flex;gap:10px;align-items:flex-start;border:1px solid rgba(241,237,230,.14);border-radius:8px;padding:11px 13px;margin-bottom:8px;cursor:pointer;font-size:.9rem}
     .bs-reason.sel{border-color:#d6302b;background:rgba(214,48,43,.1)}
     .bs-reason input{margin-top:3px;accent-color:#d6302b}
     .bs-modal textarea{width:100%;margin-top:4px;padding:10px 12px;border-radius:6px;border:1px solid rgba(241,237,230,.2);background:#14181c;color:#f1ede6;font:inherit;font-size:.9rem;resize:vertical}
     .bs-err{color:#ff8a85;font-size:.85rem;margin-top:10px;min-height:1.2em}
     .bs-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap}
     .bs-btn{border-radius:6px;padding:10px 18px;font-weight:600;font-size:.88rem;cursor:pointer;border:1px solid transparent;font-family:inherit}
     .bs-btn[disabled]{opacity:.5;cursor:not-allowed}
     .bs-btn-red{background:#d6302b;color:#fff}
     .bs-btn-ghost{background:transparent;color:#f1ede6;border-color:rgba(241,237,230,.3)}`,
    'bs-shared-modal-css'
  );

  // Opens the dialog. Calls onCancelled() after the server confirms the cancellation.
  function openCancelDialog({ requestId, onCancelled }) {
    if (document.getElementById('bsCancelBackdrop')) return;
    const token = getMyToken(requestId);

    const backdrop = document.createElement('div');
    backdrop.className = 'bs-modal-backdrop';
    backdrop.id = 'bsCancelBackdrop';
    backdrop.innerHTML = `
      <div class="bs-modal" role="dialog" aria-modal="true" aria-labelledby="bsCancelTitle">
        <h3 id="bsCancelTitle">Cancel my request</h3>
        <p class="sub">Donors who were alerted will be told straight away, so nobody travels for nothing. Why are you cancelling?</p>
        <div id="bsReasons">
          ${Object.entries(CANCEL_REASON_LABELS).map(([value, label]) => `
            <label class="bs-reason"><input type="radio" name="bsReason" value="${value}"><span>${esc(label)}</span></label>`).join('')}
        </div>
        <textarea id="bsCancelNote" rows="3" maxlength="300" placeholder="Tell us more (required for “Another reason”)"></textarea>
        <div class="bs-err" id="bsCancelErr" role="alert"></div>
        <div class="bs-actions">
          <button type="button" class="bs-btn bs-btn-ghost" id="bsKeep">Keep my request</button>
          <button type="button" class="bs-btn bs-btn-red" id="bsConfirm" disabled>Cancel request</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const $ = (sel) => backdrop.querySelector(sel);
    const confirmBtn = $('#bsConfirm');
    const errEl = $('#bsCancelErr');
    const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    $('#bsKeep').addEventListener('click', close);

    function selected() {
      const r = backdrop.querySelector('input[name="bsReason"]:checked');
      return r ? r.value : null;
    }
    function refresh() {
      backdrop.querySelectorAll('.bs-reason').forEach((l) => l.classList.toggle('sel', l.querySelector('input').checked));
      const reason = selected();
      const needsNote = reason === 'other' && !$('#bsCancelNote').value.trim();
      confirmBtn.disabled = !reason || needsNote;
    }
    backdrop.addEventListener('change', refresh);
    $('#bsCancelNote').addEventListener('input', refresh);

    confirmBtn.addEventListener('click', async () => {
      errEl.textContent = '';
      if (!token) {
        errEl.textContent = 'This request can only be cancelled from the browser that created it.';
        return;
      }
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Cancelling…';
      try {
        const result = await api(`/api/requests/${requestId}/cancel`, {
          method: 'PATCH',
          body: { requesterToken: token, reason: selected(), note: $('#bsCancelNote').value.trim() }
        });
        close();
        if (onCancelled) onCancelled(result);
      } catch (err) {
        errEl.textContent = err.message;
        confirmBtn.textContent = 'Cancel request';
        refresh();
      }
    });
  }

  global.BloodSync = {
    API_BASE, api, ApiError, esc, telHref, waHref, mapsLink,
    fmtDistance, fmtDuration, haversineMeters, validCoords,
    saveMyRequest, getMyToken, getActiveRequestId, clearActiveRequest,
    createMap, showMapError, fetchRoute, englishLabels, createSocket,
    CANCEL_REASON_LABELS, openCancelDialog
  };
})(window);
