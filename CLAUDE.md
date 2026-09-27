# Sideline

Offline PWA for an iPad, used on the touchline to log one player's football stats with a PS5 DualSense controller, without looking at the screen. Single user (a parent watching their son's games).

## Hard constraints
- **Runs fully offline** after first launch. No network calls, no CDNs, no external fonts. Everything the app needs is in `public/` and precached by `public/sw.js`.
- **No build step.** Plain HTML/CSS/JS in `public/`, served as static files. Don't introduce a bundler or framework without asking.
- **Target: iPadOS Safari, installed to the Home Screen (standalone).** Test assumptions against WebKit behaviour, not Chrome.
- **Eyes-free input first.** Every in-match action must be doable from the controller. On-screen buttons are a fallback.
- **No audio feedback** (user's explicit choice). Feedback is controller rumble (where iPadOS exposes gamepad haptics) plus a tile flash.
- **Never break stored data.** Users have real matches saved in localStorage. New fields must be optional and read defensively (`m.subs || []`, etc.). Old matches must still render.

## Files
- `public/index.html`: all screens (setup, live, summary, history) as `<section class="screen">`, plus overlays (score sheet, hold progress, focus-lost prompt, update banner, toast).
- `public/app.js`: everything else. Sections are marked with banner comments: stat model, storage, match + clock, logging, controller input, rendering, summary/history, share card, backup/restore, wake lock, wiring, updates.
- `public/styles.css`: pitch-and-chalk theme. Colour tokens on `:root`. System font stack (Avenir Next Condensed on iPad).
- `public/sw.js`: precache + cache-first fetch. **`VERSION` here is the app version shown in the UI.**
- `tests/`: Playwright tests with a mocked gamepad (`tests/helpers.js`).

## Controller map (W3C standard gamepad indices)
| Button | Index | Action |
|---|---|---|
| ✕ | 0 | Pass (+touch) |
| ○ | 1 | Touch (any other) |
| □ | 2 | Tackle (+touch) |
| △ | 3 | Shot, missed/blocked (+touch) |
| R1 | 5 | Shot on goal, saved (+shot, touch) |
| R2 | 7 | Goal (+shot on goal, shot, touch). Analog trigger with hysteresis |
| L1 | 4 | Assist (+pass, touch) |
| D-pad down | 13 | Undo: last stat or Options step, newest first. On the summary right after full time, reopens the match |
| D-pad up | 12 | Redo |
| D-pad left | 14 | Came on / went off (minutes played) |
| Options | 9 | Press: next match step, one way only: kick off → half time → 2nd half kick off → full time (ends the match). No pause, no holds. Exactly two halves |
| R3 | 11 | Hold 1.5 s: end match |
| L3 + R3 | 10+11 | Hold 2.5 s: reset match |

Free and safe to assign: L2 (6), D-pad right (15).
**Do not use Create (8) or PS (16).** iPadOS uses them for screenshots/recording and system menus, which steal focus from the app and kill controller input. Destructive or match-level actions use holds (with a progress overlay and rumble) instead of confirm dialogs, because a dialog can't be answered with the controller.

"Press only the most specific button": each event rolls up into several totals via `EVENTS[type].counts`. Tiles show totals.

## Data model (localStorage key `sideline:v1`)
```
{ current: Match | null, history: Match[], prefs: { player, team } }
Match {
  id, player, team, opponent, startedAt (ISO),
  period, running, accMs, runStart,   // clock: elapsed = accMs + (running ? now - runStart : 0)
  periodEnds: { [period]: ms },       // needed for minutes played
  startOnPitch, onPitch,
  events: [{ type, period, ms, at }],
  subs:   [{ on, period, ms, at }],
  score:  [{ side: 'us'|'them', period, ms, at }],  // goals by others; his goals come from events
  steps:  [{ kind: 'kickoff'|'halfTime', at, prev, next }],  // Options steps for undo/redo; live only
  redo:   [...]                        // stats or { step }; live match only, stripped on end
}
```
`at` (wall clock) orders the timeline; `period` + `ms` (match clock) is what's displayed.

## Deploying and updates
- Hosted on **Vercel**, deployed by pushing to GitHub. A push to `main` is a production deploy; other branches get preview URLs.
- `vercel.json` serves `public/` as static files with no install or build step (the deps are dev-only, for tests).
- Preview URLs are a different origin from production, so they have their own storage and their own Home Screen install. The real app and its saved matches live on the production domain only.
- Bump `VERSION` in `public/sw.js` on **every** deploy (`sideline-v6` → `sideline-v7`). If it doesn't change, installed copies never update.
- New versions install in the background and wait; the app shows "update ready" on the version label and a banner (hidden on the live screen). Tapping it posts `skipWaiting` and reloads. A live match survives the reload because all state is persisted on every change.
- Precache uses `cache: 'reload'` and registration uses `updateViaCache: 'none'` so host HTTP caching can't serve stale files.
- Never tell the user to delete the Home Screen icon to force an update: that wipes localStorage, including saved matches.

## iPadOS gotchas learned so far
- Safari only delivers gamepad input to a focused page. The app polls on rAF **and** an 8 ms interval, detects focus loss (`document.hasFocus()`), shows a full-screen "Controller input paused" prompt with a strong rumble, and resyncs button state on return so held buttons don't fire.
- In a normal Safari tab the address bar can grab focus. The setup screen warns when not running standalone.
- `navigator.getGamepads()` is empty until a button is pressed after page load.
- Wake Lock is requested during a match and re-requested on `visibilitychange`.
- Gamepad haptics (`vibrationActuator.playEffect`) is progressive enhancement; not yet confirmed on real iPad hardware.
- Guided Access is recommended during matches to block stray swipes.

## Testing
- `pnpm install`, then `pnpm exec playwright install chromium` once, then `pnpm test`. Tests run in Chromium with service workers blocked and a fake gamepad; they cover stat cascades, short presses, undo/redo, holds, bench/minutes, score, focus loss, and backup/restore.
- `pnpm dev` serves `public/` on http://localhost:4173. Keyboard fallback for manual testing: `1`–`7` log stats, Backspace undo, Shift+Backspace redo, Space next match step, `b` bench toggle.
- Chromium is not WebKit. Anything touching gamepad, focus, wake lock, share sheet or SW lifecycle needs a check on the real iPad (standalone) before it's trusted.
- Update flow (SW version bump → banner → reload) was verified manually in Chromium; there's no automated test for it.
