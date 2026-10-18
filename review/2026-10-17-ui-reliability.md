# UI reliability and performance — 2026-10-17

Reviewed the application source under `src/`, `main.js`, build/lint configuration,
packaging and maintenance scripts, existing review notes and relevant regressions.
Generated output, installed dependencies and binary assets were excluded from the
source review. Existing uncommitted playlist-folder and PNG-artwork changes were
preserved. The tests were run against the resulting working tree.

## Reported blank screen when enabling sounds

The user reports the entire window becoming blank in the executable. The original
source and the existing packaged archive both accepted the sound toggle in an
isolated Electron run before changes. The available application logs recorded a
sound-setting change without a corresponding renderer exception or crash event.
**The exact reported failure has not been reproduced or its cause established.**

Changes addressing this area:

- Sound playback waits for audio-context resume, handles synchronous and rejected
  asynchronous device operations, normalizes volume, treats zero as mute, limits
  overlapping notes and disconnects finished audio nodes. Disabling sounds stops
  pending notes and releases the audio context.
- Volume drags update their local value and audio volume immediately, but save
  configuration once on release, keyboard completion or blur. They previously
  wrote configuration and re-rendered the app shell on every input step.
- Result cues no longer replay restored completion counts, overlap the final
  result cue with the queue-finished cue, or omit the finished cue for one track.
- React boundaries show the error and a Restore interface button for rendering
  exceptions. A view failure retains navigation; recovery remounts React content
  while retaining the existing engine and worker webviews. These boundaries
  cannot recover a native Chromium process or graphics-driver failure.

## Other fixes

| Issue | Change |
| --- | --- |
| Every progress tick expanded profile memberships, deduplicated rows and filtered the entire queue again | Queue snapshots and active dock membership are memoized by structural version; live byte getters continue updating |
| Profile removal used only playlists visible under the current status filter | Controller removes every playlist in the profile in one operation, preserves tracks shared with other profiles and immediately persists the result |
| Loose imports dropped provider IDs, ISRC and artwork-refresh metadata; individual profile-playlist imports also lost duration | All import paths retain these fields; existing destination keys are preserved for compatibility |
| Resuming a transfer discarded expected duration and ISRC | Resume records retain both for final recording validation |
| Startup recursively scanned the download tree synchronously and could delete active partial files | Asynchronous directory traversal preserves recorded resumable paths, live writers and files changed since launch |
| Hidden app and worker timers used Chromium's default background throttling despite owning the background queue | Background throttling is disabled on the app and worker web contents |
| Changing Add-music tabs cleared busy state while the previous import continued | Tabs remain disabled until the current operation settles |

## Verification

- `npm test`: **268 passing, zero failures** (262 baseline tests plus six new
  sound, import, removal, resume and cleanup regressions).
- `npm run lint`: clean, including the browser JSX fixture.
- `npm run build:ui`: production build succeeds.
- `npm run test:electron`: passes with the actual built React interface, sound
  toggle, volume write-count check, simulated audio-device failures, preferences
  flushed to disk, local FLAC downloads, recording rejection, artwork repair,
  shared audio copies, PNG covers, pause/resume and clean quit.
- `node scripts/smoke-electron.mjs --packaged --archive
  release/reliability-fix/win-unpacked/resources/app.asar`: passes the same checks
  using the newly packaged archive.
- Browser fixture: 80 progress updates across 10,001 queue rows cause **zero
  additional full-list expansions** while visible progress continues updating;
  a structural status change still updates the dock.
- Browser fixture: a forced React rendering exception shows the recovery UI;
  restoring it retains the same queue record and transfer display.

The existing Electron smoke check expected the previous `library.json`/M3U/JPEG
layout. It was updated to check the current per-playlist folders and PNG covers
already present in the working tree. Those output changes are not introduced by
this reliability work.

These are controlled local fixtures, not a multi-hour run against the live music
providers, an availability test of their current pages, or proof that the user's
particular blank-screen trigger is eliminated. The new portable build is kept in
`release/reliability-fix/` so the existing release is not overwritten.

## Follow-up — 2026-10-18

The running portable app was identified as the older `release/` executable. Its
extracted archive hash matched `release/win-unpacked/resources/app.asar`, rather
than the fixed archive. The previous update was therefore absent from that run.

`scripts/smoke-saved-queue.mjs` now checks a paused copy of the user's saved queue
in isolated temporary state, with remote requests blocked and library export
disabled. The check restored 1 profile, 121 playlists and 1,175 canonical tracks;
11 sound toggles retained the sidebar, checked sound option and volume control.
A native page capture contained a painted interface. The check exited cleanly.
The original queue and music files were not modified by this isolated check.

The old top-level portable was backed up under `release/previous/`, and both
`release/LucidaFetcher-1.0.0-Portable.exe` and
`release/LucidaFetcher-Fixed-Portable.exe` now match the previously validated fixed
portable, SHA-256 `C049ACF5C2A05F3824B7A7E7D1CD009BD42DBCC2C8DF5A68E2BB9AB8F11506CF`.
The fixed portable was launched, and its extracted archive was verified to match
the fixed archive. Its live window was minimized during inspection; the live
sound-toggle action was not repeated through desktop automation.
