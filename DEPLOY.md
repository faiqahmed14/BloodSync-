# Deploying BloodSync

This guide takes you from the project folder to a live website that anyone can open, using only free services. It also lists the problems people usually hit and how to fix each one.

## What you need

| Thing | Why | Free option |
|---|---|---|
| A database | Stores donors and requests | MongoDB Atlas (free M0 cluster) |
| A host that keeps a Node server running | BloodSync needs live connections (Socket.io) and background jobs | Render, Railway, Fly.io, or any VPS |
| A GitHub account | Most hosts deploy straight from a repository | github.com |

> **Netlify, Vercel and GitHub Pages cannot run the backend.** They only host static pages or short-lived functions, so live tracking and the background jobs would not work. You can still host just the *pages* there (see "Hosting the website separately" below), but the backend must run on one of the hosts above.

## Step 1: Create the database (MongoDB Atlas)

1. Create a free account at mongodb.com/atlas and make a free **M0** cluster.
2. **Database Access**: add a database user. Choose a simple password with only letters and numbers. If the password contains characters such as `@ : / ? # %`, it must be URL-encoded inside the connection string (`@` becomes `%40`), otherwise you will get an "authentication failed" error.
3. **Network Access**: click *Add IP Address*, then **Allow access from anywhere** (`0.0.0.0/0`). Hosting services use changing addresses, so a fixed allow-list will lock your own server out.
4. Click *Connect*, then *Drivers*, and copy the connection string. Put the database name before the question mark, for example:
   `mongodb+srv://USER:PASSWORD@cluster0.abcde.mongodb.net/bloodsync?retryWrites=true&w=majority`

## Step 2: Create the push notification keys (once)

On your computer, inside `bloodsync-backend`:

```bash
npm install
npm run generate-vapid-keys
```

Keep the two printed values. Create them **before** donors start using the site, because every donor's browser subscribes using the public key.

## Step 3: Put the project on GitHub

The included `.gitignore` already keeps `node_modules` and your `.env` file (with your secrets) out of Git. Never commit `.env`.

```bash
git init
git add .
git commit -m "BloodSync"
# create an empty repository on GitHub, then:
git remote add origin https://github.com/YOU/bloodsync.git
git push -u origin main
```

## Step 4A: Deploy on Render (recommended)

1. On render.com choose **New > Blueprint** and pick your repository. Render reads `render.yaml` and fills in the build and start commands for you.
   (Doing it by hand instead: *New > Web Service*, build command `cd bloodsync-backend && npm ci`, start command `cd bloodsync-backend && node server.js`, health check path `/api/health`.)
2. When asked for the secret values, enter them:

| Variable | Value |
|---|---|
| `MONGODB_URI` | the connection string from Step 1 |
| `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` | from Step 2 |
| `VAPID_CONTACT_EMAIL` | your email address |
| `CORS_ORIGINS` | your site address, for example `https://bloodsync.onrender.com` |

3. Wait for the first deploy, then open the address Render gives you (it is already `https://`).

## Step 4B: Docker, Railway, Fly.io or a VPS

A `Dockerfile` is included at the project root.

```bash
docker build -t bloodsync .
docker run -p 4000:4000 --env-file bloodsync-backend/.env bloodsync
```

On Railway or Fly.io, point the service at the repository, set the same environment variables as the table above, and let it use the Dockerfile.

## Step 5: Check that it works

1. Open `https://YOUR-SITE/api/health`. You should see `"status":"ok"` and `"database":"connected"`.
2. Open the home page, check the counters and the live board.
3. Register as a donor on your phone and allow notifications and location.
4. From another device, create a request and watch the donor's phone alert, then accept and track.
5. Optional: fill the board with demo donors with `npm run seed` (see the main README).

## All settings

| Variable | Needed | What it does |
|---|---|---|
| `MONGODB_URI` | yes | Database connection string |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | for push | Keys for background notifications |
| `VAPID_CONTACT_EMAIL` | for push | Contact address sent to push services |
| `CORS_ORIGINS` | production | Comma-separated website addresses allowed to call the API. Unset means any website can. |
| `NODE_ENV=production` | recommended | Hides internal error details and enables the https redirect |
| `PORT` | no | Hosts set this for you |
| `WAVE_TIMEOUT_MS` | no | How long a wave of donors waits before widening (default 5 minutes) |
| `MAP_PROVIDER` | no | `osm` (free, default) or `google` |
| `ADMIN_TOKEN` | no | Turns on the private `GET /api/donors` list for admins (sent as an `x-admin-token` header). Leave unset to keep it off. |
| `FORCE_HTTPS=false` | no | Turn off the automatic http to https redirect |
| `RATE_LIMIT=off` | no | Turns off abuse protection (only for testing) |
| `DB_CONNECT_ATTEMPTS` | no | Database connection retries at start-up (default 4) |

## Using Vercel for the website

Vercel cannot run the BloodSync server (it needs live WebSocket connections and background jobs, which Vercel's short-lived functions do not support). Use **Vercel for the pages and Render for the backend**:

1. Deploy the backend on Render first (Steps 1 to 4A above) and note its address, for example `https://bloodsync-api.onrender.com`.
2. In `bloodsync-frontend/bloodsync-config.js`, set `window.BLOODSYNC_API_BASE = 'https://bloodsync-api.onrender.com';` and push the change to GitHub.
3. On vercel.com choose **Add New > Project**, import your repository, and set:
   - **Framework Preset:** Other
   - **Root Directory:** `bloodsync-frontend`
   - **Build Command** and **Output Directory:** leave empty (if Vercel insists on an output directory, enter `.`)
4. Click **Deploy**. Vercel gives you an address such as `https://bloodsync.vercel.app`.
5. In the Render dashboard open your service's **Environment** tab and set
   `CORS_ORIGINS=https://bloodsync.vercel.app,https://bloodsync-*-YOURTEAM.vercel.app`
   (the second entry also allows Vercel's preview deployments; `*` matches one chunk of letters, digits and hyphens). Save, and Render restarts the service.
6. Open the Vercel address and check the live board loads. If you see CORS errors in the browser console, the address in `CORS_ORIGINS` does not match exactly (it needs `https://` and no trailing path).

## Hosting the website separately

Normally the backend serves the pages too, and nothing needs configuring. If you want the pages on a static host (Netlify, GitHub Pages) and the API elsewhere:

1. Upload the `bloodsync-frontend` folder to the static host.
2. In `bloodsync-frontend/bloodsync-config.js`, set `window.BLOODSYNC_API_BASE = 'https://your-backend.onrender.com';`
3. On the backend, set `CORS_ORIGINS` to the static site's address.

## Troubleshooting

| What you see | Why | Fix |
|---|---|---|
| Server stops at start-up with "rejected the username or password" | Wrong password, or special characters not URL-encoded | Re-check `MONGODB_URI`; encode special characters or use a simpler password |
| Server stops with "could not be reached" | Atlas is blocking the host | Atlas > Network Access > allow `0.0.0.0/0` |
| First visit shows "Waking up the server" | Free plans sleep after about 15 minutes of silence | Wait up to a minute. It only happens on the first visit after a quiet spell. A paid plan or an uptime pinger such as UptimeRobot hitting `/api/health` every 10 minutes avoids it |
| Notifications never arrive | Not on https, permission denied, or VAPID keys missing | Use the `https://` address, allow notifications, set both keys and redeploy. On iPhone, install the app first (Share > Add to Home Screen) |
| "Location blocked" or the map shows the wrong place | Browsers only share location on https or localhost | Always use the `https://` address |
| Old design after a redeploy | A cached copy | The server already tells browsers to re-check pages. A hard refresh (Ctrl+Shift+R) fixes any leftover |
| Browser console shows CORS errors | Website and API are on different addresses | Set `CORS_ORIGINS` to the exact website address (with `https://`, no trailing slash) |
| "Too many requests" (429) | The abuse protection triggered, for example many registrations from one connection | Wait a few minutes. Limits: 20 requests per 10 minutes and 30 registrations per hour per connection |
| Live updates are slow | A proxy blocks WebSockets | BloodSync automatically falls back to regular polling, nothing to do |
| Map labels are not English | WebGL or the map CDN is blocked on that network | The map falls back to plain OpenStreetMap tiles. Everything else still works |

## Security checklist before you share the link

- Rotate any password or key that has ever been pasted into a chat or committed to Git.
- Set `CORS_ORIGINS` and `NODE_ENV=production`.
- Keep `.env` out of Git (the included `.gitignore` does this).
- Donor CNIC numbers are stored but never sent back to any browser. Keep it that way.
- Back up your Atlas data (Atlas has scheduled backups on paid tiers, or use `mongodump`).

## Known limits

- Run **one** server instance. Live-update rooms are held in memory, so several copies would not see each other's events.
- The public OSRM routing server and Nominatim address lookup are free community services. They are fine for a small launch but have fair-use limits. For heavy use, run your own or switch routing to Google (`MAP_PROVIDER=google`).
- Web Push on iPhone requires iOS 16.4 or later and the app added to the Home Screen.
