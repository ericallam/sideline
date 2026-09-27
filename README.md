# Sideline

Offline iPad PWA for logging a player's football stats with a PS5 controller, eyes-free from the touchline.

## Develop
```sh
pnpm install
pnpm exec playwright install chromium   # once
pnpm dev                                # http://localhost:4173
pnpm test
```

The app is plain static files in `public/`; there's no build step. See `CLAUDE.md` for architecture, the controller map, the data model and iPadOS gotchas.

## Deploy
Vercel, via GitHub. `vercel.json` serves `public/` with no install or build step. Pushing to `main` deploys production; branches get preview URLs.

Before pushing a change to `main`, bump `VERSION` in `public/sw.js`. Installed copies then show "update ready" and a banner to update.

## Install on the iPad
1. Open the site in Safari, then Share → Add to Home Screen, and always launch from the icon.
2. Pair the DualSense (hold PS + Create until the light flashes, then pick it in Settings → Bluetooth).
3. Settings → General → Game Controller → DualSense: turn off Share Gestures.
4. Optional: turn on Guided Access to lock out stray swipes during a match.

Saved matches live on the device. Use Past matches → Back up all before reinstalling anything.
