# BloodSync backend

> **Going live?** Read [`../DEPLOY.md`](../DEPLOY.md) for a step-by-step guide (MongoDB Atlas, Render, Docker) and a troubleshooting table.

The complete backend: donor registration, blood requests, the wave-escalation matching engine, Web Push notifications, and Socket.io real-time updates for the live board and live tracking.

## Setup

```bash
npm install
cp .env.example .env        # Windows: copy .env.example .env
npm run generate-vapid-keys
```

Copy the printed `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` into `.env`. You do **not** need to paste the public key into the frontend any more, the website fetches it from the server (`GET /api/config`), so the two can never get out of step. (A mismatched key was why push notifications silently never arrived before.)

Edit `.env`:
- `MONGODB_URI`: from MongoDB Atlas. Create a free M0 cluster, add a database user, allow your IP (or `0.0.0.0/0` for development), then copy the connection string from "Connect > Drivers".
- `WAVE_TIMEOUT_MS`: how long a wave waits before escalating. Defaults to 5 real minutes (300000). Turn this down to something like 15000 (15 seconds) while testing locally, so you don't have to wait 5 minutes to see escalation happen.
- **Maps need no setup.** By default the app uses free maps: Leaflet with OpenFreeMap tiles (no API key, no account, no credit card) and free OSRM routing. Labels are shown in **English** wherever OpenStreetMap has an English name (otherwise the Latin-script name, then the local name).
- `MAP_PROVIDER=google`: optional. Switches to Google Maps instead. Google requires a Cloud billing account (a card on file, even though it has a free monthly allowance, check Google's current pricing page for the amounts). If you do: create a key, enable **Maps JavaScript API** and **Routes API**, and set `GOOGLE_MAPS_API_KEY` (plus optionally `GOOGLE_MAPS_MAP_ID`, `GOOGLE_ROUTES_API_KEY`, `GOOGLE_ROUTES_TRAFFIC=true`). Restrict the key to your website's address once deployed. Leave `MAP_PROVIDER` out and none of this is used, a key in `.env` is ignored.
- `OSRM_BASE_URL`: optional. The free routing server (public demo server by default). Used for all routes unless you opt in to Google, and as the fallback if Google fails; if OSRM is also unreachable the map shows a straight line.

Run it:

```bash
npm run dev    # with auto-restart (nodemon)
# or
npm start
```

**Then open http://localhost:4000**: the backend also serves the website (`../bloodsync-frontend`), so one command runs everything, API and pages on the same origin.

## How a request actually flows through this backend

1. `POST /api/requests` creates the request and immediately calls the matching engine, which finds the nearest 20 eligible donors (exact blood group, and only donors willing for "any request", for `direct-need`; any active donor for `replacement`). Each donor is alerted two ways: a live **pop-up** over Socket.io (if they have the site open) and a **Web Push** notification (works with the site closed). The response includes a one-time secret `requesterToken`, only the browser that created the request holds it, and it is required to cancel the request.
2. A background job (`jobs/waveTimeoutChecker.js`) checks every 30 seconds for any request whose current wave has gone unanswered past `WAVE_TIMEOUT_MS`. If so, it notifies the next batch (50, then 100, then 200, then another 200, indefinitely) of donors who haven't been asked yet.
3. `PATCH /api/requests/:id/accept` locks in the first donor to accept (race-safe) and **returns the patient's full details** (name, age, hospital + area, requester phone + relationship, doctor, notes, coordinates) so the donor can call them. Before accepting, a donor only sees a limited preview, no names, no phone numbers. Everyone else who was asked is told the request is filled (pop-up closes + push).
4. `PATCH /api/requests/:id/start-transit` flips the request to `in-transit`.
5. `PATCH /api/requests/:id/location` is called every few seconds by the donor's browser from the moment they accept; each ping is relayed live over Socket.io to the requester's tracking page. Only the accepted donor can send it, and it is refused (HTTP 409, which tells the donor's device to stop) once the request is cancelled or completed.
6. `PATCH /api/requests/:id/complete` marks it done and starts the donor's 90-day cooldown. Either the accepted donor (`donorId`) or the requester (`requesterToken`) may confirm it.
7. `PATCH /api/requests/:id/cancel`: **"Cancel My Request"**. Needs the `requesterToken`. Reasons: `donor-not-found`, `arranged-locally`, `no-longer-needed`, or `other` (a written note is required). It withdraws every open invitation and tells all alerted donors, and the donor already on their way, by live event and push ("no need to travel").

## API endpoints

### Donors
- `POST /api/donors`: register a donor.
- `GET /api/donors`: **admin only.** Answers 404 unless `ADMIN_TOKEN` is set in `.env` and the request sends it in an `x-admin-token` header. It never includes CNIC numbers or push subscriptions. (It used to be public and returned full records to anyone.)
- `GET /api/donors/:id`: fetch one donor (auto-clears an expired cooldown).
- `GET /api/stats`: public, cached for 30 s. Real counters for the homepage (active donors, cities, completed donations, open requests, average time to a match). No personal data.
- `GET /api/reach?lng=&lat=&type=&bloodGroup=`: how many donors the matching engine would pick from within 5 km and 15 km. Counts only. Used by the "how many donors will be alerted" message on the request form.
- `GET /api/health` and `GET /healthz`: status, database state and uptime, for hosting health checks.
- `GET /api/donors/:id/notifications`: pending requests currently waiting on this donor (limited preview: no patient name or phone numbers).
- `GET /api/donors/:id/active-request`: the donation this donor has accepted and not finished, with full patient details (restores the map after a page reload).
- `PATCH /api/donors/:id`: update editable fields. Sending `{ "status": "inactive" }` pauses alerts and `"active"` resumes them. A donor still inside their 3-month rest period cannot resume early (HTTP 409).
- `POST /api/donors/:id/push-subscription`: save a donor's Web Push subscription object (get this from the frontend's `PushManager.subscribe()` call).

### Requests
- `POST /api/requests`: submit a blood request, triggers the matching engine.
- `GET /api/requests/:id`: poll status (never includes the secret token or the list of alerted donors).
- `PATCH /api/requests/:id/accept`: a donor accepts; body `{ donorId }`. Only a donor the request was sent to may accept. Returns the full patient/contact details.
- `PATCH /api/requests/:id/decline`: a donor declines this wave.
- `PATCH /api/requests/:id/start-transit`: donor is now heading to the hospital.
- `PATCH /api/requests/:id/location`: accepted donor's live location ping; body `{ donorId, coordinates: [lng, lat] }`.
- `PATCH /api/requests/:id/complete`: mark done, starts the 90-day cooldown; body `{ donorId }` or `{ requesterToken }`.
- `PATCH /api/requests/:id/cancel`: body `{ requesterToken, reason, note? }`.

### Board
- `GET /api/board`: live donor counts per blood group, optionally `?city=`.

### Other
- `GET /api/route?from=<lng>,<lat>&to=<lng>,<lat>`: shortest driving route. Free OSRM by default (`source: "osrm"`); the Google Routes API (`"google"`) only if `MAP_PROVIDER=google` and a key is set; a straight line (`"straight-line"`) if routing is unreachable, so the map never goes blank. Of the alternatives returned, the one with the smallest distance is `shortest` (the others are `alternatives`).
- `GET /api/config`: public settings for the frontend (the VAPID public key, the map provider, and, only when Google is selected, its browser key and map ID).

## Socket.io events

Client emits:
- `board:join`: subscribe to live board refreshes. (A socket forgets its rooms every time it reconnects, so the frontend re-sends this on every `connect`.)
- `request:join` / `request:leave` (with a request ID), live updates for one specific request.
- `donor:join` / `donor:leave` (with a donor's database ID), receive that donor's pop-up alerts.

Server emits:
- `board:update`: tells listeners to refetch `GET /api/board`. Sent when a donor registers, changes status, or completes a donation.
- `donor:request`: sent to one donor when a new request was just sent to them (limited preview payload).
- `donor:closed`: sent to donors when a request is no longer open (`reason`: `filled` or `cancelled`).
- `request:matched`: sent once, with the accepted donor's details and ETA.
- `request:status`: whenever status changes (`matched`, `in-transit`, `completed`, `cancelled`, cancelled also carries `reason` and `note`).
- `request:location`: on every donor location ping.

## Seeding the 5,000-donor dataset

The `bloodsync_donors_5000` dataset (all 60 cities, every blood group represented at least 10 times per city) is included at `data/donors.csv` and can be loaded straight in:

```bash
npm run seed
```

This maps every spreadsheet column onto the real Donor schema, converting the sheet's "Yes"/"No" text into actual booleans, turning "First-time donor" into a null last-donation-date, and assigning each donor a coordinate near their city's center (with a small random spread, since the sheet only has a city name, not GPS coordinates) so they're immediately usable by the matching engine's `$geoNear` queries. After seeding, the donor-ID counter is synced to 5000, so the next real registration continues from `BS-05001` instead of colliding with seed data.

If you need to re-run it (e.g. after wiping your dev database), use:

```bash
node scripts/seedDonors.js --reset
```

which removes only these 5,000 seeded donors first (matched by their exact donor IDs), rather than touching any real donors who may have registered since.

## Connecting the frontend

The `bloodsync-frontend` folder is wired to this API: `index.html` (everything for donors and requesters), `tracking.html` (the requester's live tracking page), `bloodsync-shared.js` (shared helpers), and `sw.js` (the service worker for push).

Where the frontend looks for the backend is decided in `bloodsync-shared.js`:
- opened from this backend (`http://localhost:4000`, or any deployed domain serving it) → same server, nothing to configure;
- opened from another local server such as VS Code Live Server → `http://localhost:4000`;
- frontend hosted separately from the backend (e.g. Netlify + Render) → add `<script>window.BLOODSYNC_API_BASE = 'https://your-backend.onrender.com';</script>` before `bloodsync-shared.js` in both HTML files.

CORS and Socket.io are both configured to accept any origin (`cors()` with no restrictions, `cors: { origin: '*' }` in `sockets/index.js`) so this works out of the box for development. Tighten both to your real frontend's exact origin before putting this anywhere public.

Push notifications need a real web origin: use `http://localhost:4000` (or https when deployed). They don't work from a `file://` URL.

## Testing it locally without a frontend

```bash
# Register a donor
curl -X POST http://localhost:4000/api/donors \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Ahmed Raza", "age": 27, "gender": "Male",
    "cnic": "42101-1234567-1", "weightKg": 72, "bloodGroup": "O+",
    "phone": "0300-1234567", "city": "Karachi",
    "address": "House 12, Street 4, Gulshan-e-Iqbal, Karachi",
    "coordinates": [67.0822, 24.9056], "willingFor": "any"
  }'

# Submit an urgent direct-need request nearby
curl -X POST http://localhost:4000/api/requests \
  -H "Content-Type: application/json" \
  -d '{
    "type": "direct-need",
    "patient": {"name": "Bilal Ahmed", "age": 34, "gender": "Male"},
    "bloodGroup": "O+", "unitsRequired": 2, "reason": "Surgery",
    "hospital": {"name": "Civil Hospital", "area": "Saddar, Karachi"},
    "doctor": {"name": "Dr. Fatima", "contact": "0321-1234567"},
    "requester": {"relationship": "Son", "contact": "0300-7654321"},
    "coordinates": [67.0100, 24.8600]
  }'
```

The response to the second call contains a `requesterToken`, keep it, you need it to cancel:

```bash
curl -X PATCH http://localhost:4000/api/requests/<id>/cancel \
  -H "Content-Type: application/json" \
  -d '{ "requesterToken": "<token>", "reason": "arranged-locally" }'
```

A donor with no Web Push subscription simply skips the push step (logged, not an error); the `Notification` record, the pop-up event and the wave bookkeeping still happen.

## Troubleshooting

**"Could not reach the backend, is it running?" right after submitting a request.** This message used to appear even though the request had been created. The tracking page crashed while reading the donor's location from a brand-new request (the server returned an empty `donorCurrentLocation: { type: "Point" }` with no coordinates), and the crash handler mislabelled it as a connection failure. Fixed on both sides: the server no longer returns that empty object, the tracking page checks it, and "can't reach the server" is now shown only for a genuine network failure. If you *do* see the connection message, check that `npm start` is running and that Atlas allows your current IP (the server exits if it can't reach MongoDB, and prints a hint).

**The map looks plain / the labels aren't English.** The English vector map needs WebGL and access to `unpkg.com` and `tiles.openfreemap.org`. If either is blocked (some school/office networks, very old browsers) the app quietly falls back to plain OpenStreetMap tiles, the map still works, but labels follow each place's local language. Markers, routes and live tracking are unaffected.

**(Google only) The map box says "Google Maps isn't set up yet" / "Google rejected the map key".** Only relevant if you set `MAP_PROVIDER=google`. Add `GOOGLE_MAPS_API_KEY` and restart. If Google rejects it: billing must be on, *Maps JavaScript API* must be enabled, and a website-address restriction must include the address you use (locally, `http://localhost:4000/*`). If distances show "straight line", also enable the *Routes API*, the server log prints Google's exact complaint once.

**I registered as a donor but never got an alert.** By design only the nearest 20 eligible donors are alerted first (then 50, 100, 200 as each wave times out). With the 5,000-donor seed data, a new donor in a busy city may not be in the first 20 for a `replacement` request (it considers every blood group). To test quickly: submit a `direct-need` request for your own blood group, or set `WAVE_TIMEOUT_MS=15000` and wait for the next wave. Donors who donated in the last 90 days are in cooldown and aren't alerted or counted on the board until it ends.

**Push works but the pop-up doesn't (or the other way round).** The pop-up needs the page open (it uses Socket.io); push works with the page closed but needs notification permission. The donor dashboard shows the current push state and an "Turn on notifications" button.

## What's not included (by design, per the earlier free-stack decisions)

- Real SMS/WhatsApp Business API delivery, genuinely not free at scale; Web Push is the zero-cost channel this project relies on instead.
- A hospital lookup/autocomplete: the recommended approach is querying OpenStreetMap's Overpass API live rather than maintaining a static hospital list, since no single free source has a complete, accurate, coordinate-tagged list of every hospital in Pakistan.
