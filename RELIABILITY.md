# Reliability audit — 2026-10-04

## Source access — 2026-10-26

- Workers share one active scrape per site, with at least two seconds between
  worker-directed navigations. Lucida's five music services share this budget;
  Monochrome has a separate budget. Downloads can still run concurrently.
  Requests generated internally by a site's own JavaScript are not individually paced.
- HTTP 429 responses from source pages/APIs preserve `Retry-After` (seconds or
  an HTTP date). Without that header, cooldowns grow from 30 seconds to five
  minutes. Deadlines persist in config and survive manual retries and restart.
  A queued worker waits cancellably; the throttled attempt can try the other
  enabled site. HTTP 403, invalid countries, and backend errors are distinct.
- Country fallback uses Lucida's advertised options without revisiting failed
  regions in the same attempt. Successful search regions are remembered per
  provider. This selects a catalog region; it does not change the public IP.
- Matching Lucida release pages are cached in memory for ten minutes (200
  entries maximum). Cache keys include the service, query, and recording identity;
  every cached visit re-runs matching, and stale pages fall back to search once.
- Settings → Sources → Monochrome custom API accepts a compatible HTTP(S) HiFi
  endpoint. Apply it for the next search, or clear it to restore the default.
  The app configures Monochrome's `dev-mode-enabled` / `dev-mode-url` settings
  before navigating to search. You must supply a working backend; this setting
  does not create one or remove its upstream limits.
- Source diagnostics record HTTP status, host, and Retry-After without logging
  request URLs or headers containing credentials. Unrelated third-party requests
  and late responses from a previous worker attempt cannot trigger cooldowns.

Regression coverage lives in `test/source-access.test.mjs`, the worker and
cascade tests, and the Electron smoke check's local HTTP 429/403 fixtures.
These checks do not establish current provider availability or live quotas.

## Keep trying

Enable **Settings → Downloading → Keep trying** to automatically retry missing
tracks after all searches and transfers finish. The preference survives restart.
Only missing tracks are retried; downloaded and cancelled tracks are excluded.
Retries wait 30 seconds initially, then back off to a maximum of 5 minutes.
Successful downloads reset the delay. Each pass clears temporary source-health
failures so recovered providers get another chance.

Pause stops new passes and pauses live transfers. Turning the option off cancels
the scheduled pass. Cancel all cancels active/queued tracks and stops retries
for the session. An explicit retry, newly added music, or re-enabling Keep trying
starts retries again. Removing all missing tracks clears the timer.

## Fixes

- Cancellation interrupts navigation, injection, and injection-retry waits;
  webview reset destroys lingering scripts and releases remote page resources.
- DOM listeners are released even when navigation throws synchronously.
- Download waits remove abort listeners on every settlement, handle pre-aborted
  signals, and release replaced promises. Engine disposal removes IPC listeners,
  subscriptions, persistence timers, and worker views.
- A failed adopted transfer aborts its old waiter before restarting the chain.
- Pool slots cannot run the same item twice concurrently. Lowering concurrency
  respects total running work, and cancelling paused queues resolves idle waits.
- Pause/resume now reaches Chromium transfers as well as the search pool.
- Interrupted transfers get three bounded resume attempts. Transfers with no
  new bytes for two minutes fail over; user and speed-limit pauses are excluded.
- Save paths avoid existing files and concurrent writers, handle more than 99
  collisions, normalize Windows path case, and sanitize reserved DOS filenames.
- Save-path ownership remains reserved throughout asynchronous metadata repair.
  Setup and finalization failures settle the renderer rather than hanging tracks.
- Queue, config, manifest, and report writes serialize per destination and freeze
  snapshots before asynchronous work. Queue/history deletion follows earlier
  writes; shutdown waits for writes already running and download finalization.
- Closing without the tray uses the same flush handshake as Quit, and another
  quit request cannot bypass a flush in progress.
- JSON and artwork responses are bounded while streaming, including responses
  without Content-Length. Folder scans open at most 16 files concurrently.
- Large retries/cancellation emit one structural update per batch. Only transfer
  rows subscribe to byte updates. Retry reports refresh and removed groups release
  report bookkeeping; report-cache eviction waits for pending writes.
- Spotify embed requests have a deadline instead of hanging imports indefinitely.

## Verification

`npm test`: **203 passing tests**, including 28 new reliability regressions.

`npm run lint`: zero problems.

`npm run test:electron`: builds the production UI and boots an isolated Electron
app with a local fixture server. The check verifies the real Settings checkbox
and saved preference, injected cascade, automatic retry after failure, two playable
FLAC downloads with embedded art, distinct paths for identical filenames,
unchanged downloaded bytes, live pause/resume, disposal, clean quit, and both
manifest entries flushed to disk. It needs ffmpeg on PATH to generate fixtures.

These checks cover controlled failure and success paths. They do not establish
current availability or unchanged markup of Lucida/Monochrome, nor constitute a
multi-hour memory profile against those external sites. No user's runtime state
or music library is used by the integration check.
