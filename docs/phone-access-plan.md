# Phone Access Plan

Status: planning, not started. Picks up the discussion on extending Forge to
the iPhone for both logging and viewing progress on the go.

**When work on this starts, do it in a separate branch off `main`** — don't
develop directly on `main`.

## Goal

Use Forge from an iPhone, away from the Mac, for:
- Logging data (reps, habits, weight, weekly sessions)
- Viewing the dashboard/trends

## Decisions made so far

1. **Data stays on the Mac.** No paid hosting, no migrating off SQLite, no
   cloud database. The existing `data/tracker.db` remains the single source
   of truth, backed up via Google Drive sync as today.
2. **Network access via Tailscale**, not a cloud host. Considered and
   rejected always-on hosting options (DigitalOcean ~$4/mo, Fly.io ~$2/mo,
   Oracle Free Tier $0 but fiddly signup, Railway/Render $5-7/mo) purely to
   avoid recurring cost and avoid moving data off the Mac. Tailscale creates
   a private VPN mesh between the Mac and iPhone so the phone can reach the
   Mac's local Flask server (`:8420`) from anywhere with internet — not just
   home Wi-Fi — with no port forwarding and no public exposure.
3. **Client approach**: still open, but leaning toward starting cheap and
   validating before investing more:
   - **PWA** (add a manifest + service worker to the existing frontend) —
     lowest effort, reuses all current UI code, gives a home-screen icon and
     full-screen feel via "Add to Home Screen." Recommended first step.
   - **Capacitor/Ionic wrapper** — same web UI, real native shell, adds push
     notifications and a proper app icon without a rewrite. Possible step up
     if PWA feels lacking.
   - **True native (SwiftUI)** — best feel/offline behavior, but a full UI
     rewrite in Swift. Only worth it once phone access has proven valuable.
     Since Forge is single-user, this would be sideloaded via Xcode rather
     than distributed through the App Store.

## Known caveat

The Mac must be **awake**, not just powered on, for the Flask server to
respond over Tailscale. Sleep needs to be disabled (at least on power) —
e.g. System Settings → Lock Screen, or a tool like Amphetamine — for phone
access to work reliably whenever needed.

## Next steps (not started)

1. Install Tailscale on the Mac and iPhone, confirm the phone can reach
   `http://<mac-tailscale-name>:8420` from cellular data (away from home
   Wi-Fi).
2. Disable Mac sleep (or find an acceptable schedule) so the server stays
   reachable.
3. Convert the existing frontend into a PWA (manifest + service worker) so
   it can be added to the iPhone home screen.
4. Use it for a while from the phone; decide whether Capacitor or native
   SwiftUI is worth the extra investment based on real usage, not
   speculation.
