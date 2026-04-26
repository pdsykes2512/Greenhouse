# Greenhouse — PWA + Push Notifications

The web dashboard is a Progressive Web App. On a phone you can "Add to home
screen" and it launches like a native app, works offline (last-known data),
and can receive push notifications even when closed.

## What you need

- The dashboard accessible over **HTTPS** (Cloudflare Tunnel does this — see
  [CLOUDFLARE_TUNNEL.md](CLOUDFLARE_TUNNEL.md))
- A VAPID keypair on the server (one-time setup)
- The user grants notification permission in their browser

## One-time server setup

### 1. Generate VAPID keys

```bash
cd server
npm install            # installs web-push if not already there
npm run generate-vapid
```

This writes `server/vapid-keys.json` (gitignored, mode 0600). The script
refuses to overwrite — if you ever need to rotate, pass `--force`, but
**rotation invalidates every existing browser subscription**, so users will
have to re-enable alerts.

### 2. Set the VAPID subject (optional but recommended)

The subject is a contact URL Cloudflare uses for abuse reports. By default
it's `mailto:admin@example.com` — set yours via env var when starting the
server:

```bash
VAPID_SUBJECT=mailto:you@yourdomain.com node server.js
```

(Or set it in the systemd unit's `Environment=` line.)

### 3. Restart the server

You should see `Web Push configured` in the boot log.

## How users enable notifications

1. Open the dashboard over HTTPS in a browser
2. Click the **🔔 Enable Alerts** button in the header
3. Browser asks for notification permission; click Allow
4. Subscription is sent to the server and stored in the
   `push_subscriptions` table

Once granted, the button hides on subsequent visits — the existing
subscription is reused. Clearing browser storage will require re-enabling.

### iOS Safari quirk

iOS only supports Web Push (Safari 16.4+) **for installed PWAs**. Users on
iPhones must:

1. Open the dashboard in Safari
2. Tap Share → Add to Home Screen
3. Open the app from the home screen
4. *Then* enable notifications

Android, desktop Chrome and Firefox have no such restriction.

## Testing

```bash
# Confirm the public key endpoint
curl https://your-host/api/push/vapid-public-key

# Send a test push to every subscriber
curl -X POST https://your-host/api/push/test
# → {"status":"ok","sent":N,"failed":0}
```

If `sent` is 0, no browsers have subscribed yet.

## Alert types

The alert engine (`server/alerts.js`) runs every 60 s and checks:

| Kind | Trigger | Cooldown |
|---|---|---|
| `data-stale` | No sensor data received for 10+ minutes | 1 hour |
| `plant-dry-too-long` | Moisture below dry threshold for 12+ hours straight | 6 hours per plant |

Each alert is logged to `alert_log` so we don't spam the same notification —
once fired, a given alert type won't re-fire until the cooldown elapses.

### Adding new alert types

1. Add a check function to `server/alerts.js` that calls `maybeFire(kind, plantNum, payload)`
2. Add an entry to `COOLDOWN_MS` for the new kind
3. Add it to `tick()` so it runs each cycle

## Service worker behaviour

`server/public/sw.js`:

- **Install**: precaches the app shell (HTML, JS, manifest, icons)
- **Activate**: clears old shell caches when the version bumps
- **Fetch**: network-first for `/api/*` (always try fresh data, fall back to
  last-known on offline); cache-first for static assets
- **Push**: shows a notification with the title/body from the payload
- **Notification click**: focuses the existing PWA window or opens a new one

To force the SW to update after a code change, bump `VERSION` at the top of
`sw.js`. Browsers re-check the SW file on each visit and apply changes when
the byte content differs.

## Files added for the PWA

```
server/
├── alerts.js                    Alert engine (event detection + push)
├── push.js                      web-push helper, VAPID config
├── scripts/
│   └── generate-vapid.js        One-shot VAPID key generation
├── vapid-keys.json              (gitignored — generated locally)
└── public/
    ├── manifest.json            PWA manifest
    ├── sw.js                    Service worker
    ├── icon-192.svg             App icon (small)
    ├── icon-512.svg             App icon (large)
    └── icon-maskable.svg        App icon (Android adaptive)
```
