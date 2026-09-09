# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Electron desktop app that takes a pasted playlist/track link and fetches the audio, by driving hidden `<webview>`s through two scraper sites (lucida.to, monochrome.tf) and falling back to yt-dlp on YouTube. Files land under `KAN/<folder>/`, with a per-folder JSON report of what was downloaded and what was missed.

## Commands

```bash
npm test                              # full suite (node --test, no build needed)
node --test test/matching.test.mjs    # one file
npm start                             # run the app against the built UI in dist/
npm run build:ui                      # Vite build of src/ui -> dist/
npm run dev:ui                        # Vite dev server on :5173 (mock engine, no Electron)
npm run icons                         # redraw build/icon.{ico,png} + tray.png from scripts/make-icon.mjs
npm run pack                          # unpacked build in release/win-unpacked (fast, for testing)
npm run dist:win                      # icons + UI + NSIS installer in release/
```

Working on the UI against the real engine: `npm run dev:ui` in one shell, then `LF_DEV=1 npm start` — main.js loads `http://localhost:5173` instead of `dist/index.html`. `npm start` alone requires a prior `build:ui`, or the window shows a build-me placeholder.

`LF_VERBOSE=1` echoes the session log to stdout. Every run also writes `logs/session-<ts>.jsonl` (one JSON event per line); the renderer forwards its events to the main process over the `log` channel so the main process is the only writer. The last 20 sessions are kept and older ones pruned on launch.

**Settings -> Diagnostics -> Export diagnostics report** turns a session log into one Markdown file: what failed, which sources answered and how often, the full chain of sources tried for every track that did not download, then the raw events. That file is the thing to hand over when something goes wrong - the `.jsonl` is written for a machine, this is written for a person.

## Architecture

Three layers, deliberately separated:

**`src/engine/*.mjs` — the download engine.** Plain ESM, no React, no DOM, no Electron. Every dependency (the webview, IPC, the clock) is injected, which is why the whole attempt flow runs under `node --test`. `index.mjs` is the single import surface.

- `chain.mjs` — `buildPlan()` turns a track into an ordered array of attempt descriptors (`{source, service, query, variantIndex}`): each Lucida store × N query variants, then Monochrome, then YouTube as terminal fallback. The plan is data, so a fallback is an index bump and the UI can say what comes next.
- `controller.mjs` — the queue and per-track state. One pool task owns a track's *whole* chain, so a track stays on one webview for its lifetime. It owns chain state only; byte-level transfer progress goes straight from the main process to whoever renders it.
- `pool.mjs` — fixed slots pulling from one queue (default concurrency 3). A slot index maps to a worker webview; the pool itself knows nothing about Electron.
- `worker.mjs` — carries one attempt: navigate, inject the cascade script, await an outcome.
- `matching.mjs` — the single source of truth for "is this hit the track we asked for?", used both here and inside the scraped page.
- `variants.mjs`, `status.mjs`, `sources.mjs` (link → track list), `yt-fallback.mjs` (scores YouTube candidates), `cascade-*.mjs` (the injected page scripts).
- `electron-bridge.mjs` / `renderer-integration.mjs` — the only files that know about webviews and `ipcRenderer`. `startEngine()` is the boot entry point.

**`src/ui/` — React 19 + Vite.** The engine is an external event-emitting store subscribed to with `useSyncExternalStore`; it is never React state. `src/ui/engine.js` is the bridge and falls back to `mock.js` outside Electron. `App.jsx` → `views/{QueueView,AddView,SettingsView}.jsx`.

**`main.js` — the Electron main process.** Owns persistent state, downloads, yt-dlp (`youtube-dl.js`), and the folder reports. Window runs with `nodeIntegration: true, contextIsolation: false, webviewTag: true` — so the renderer uses `window.require('electron')` directly, no preload.

`index.html` + `renderer.js` at the repo root are the pre-React UI. Nothing loads them any more; the app loads `dist/index.html`. Do not add to them.

## Invariants worth knowing before editing

**Injected scorer functions must have no free identifiers.** `matching.mjs` generates the scripts injected into scraped pages via `Function.prototype.toString()`. Minification renames module-scope bindings, and the stringified body then refers to names the generated wrapper never declared — which breaks every search in the built app while dev and tests stay green. Every injectable function therefore takes `FOLD`, `STOP`, `ALTERING`, `norm`, `toks` as *parameters*. `test/injectable.test.mjs` re-creates each one via `new Function` to enforce this, and `vite.config.mjs` sets `minify: false` as belt and braces.

**Webviews live outside the React tree.** `#scraper-view` and `#worker-views` are declared in `src/ui/index.html`, not rendered by React — a re-render remounts a `<webview>`, which kills a scrape or cancels a transfer in flight. The scraper view and the worker views are separate on purpose.

**Download context is keyed by `webContents` id.** `main.js` keeps `pendingContexts: Map<webContentsId, ctx>`; a global "next download" slot would let two concurrent workers cross their save paths, which is silent corruption (right file, wrong folder, wrong report). A worker that navigates away sends `clear-download-context`.

**A worker webview's first `dom-ready` is `about:blank`.** `viewAdapter` in `electron-bridge.mjs` filters it; passing it through injects into a document already navigating away.

**A transfer is handed off at `will-download`, never at the click.** A scraped attempt ends when the download *starts*, not when the file lands: the worker returns `transferring`, the pool slot and its webview go to the next track, and the controller follows the file from outside the pool (`controller.transfers`). This is only safe because `takeDownloadContext` in `main.js` *consumes* the context when `will-download` fires - after that moment the `DownloadItem` belongs to the session and nothing the page does next can reach it. Release any earlier - on the click, which is only a promise of a file - and navigating the view away kills a download that never existed. A handed-off transfer that then fails must re-enter the chain at `rec.resumeIndex` rather than restart it; `maxTransfers: 0` disables the split entirely and is the first thing to try if transfers start dying.

**`maxTransfers` must stay above `concurrency`.** They were both 3, which meant the pipeline stalled exactly where it was meant to help: once three transfers were detached, the next chain waited for its own file *inline*, holding its slot, and three of those parked every webview on the network. Searching stopped dead until a file landed, so downloads ran in visible batches of three with a gap after each. It is 6 (two batches of fetch-ahead), so slots keep searching while files drain and there is always something already fetched for the network to pick up. Not unbounded: the queue would otherwise race arbitrarily far ahead of the network, and every extra simultaneous transfer is another share of the same bandwidth and another request the scraper sites can rate-limit.

**`ready` is a real status, not cosmetic.** A scraper site hands out no parked link - "the page finished preparing the file" and "the transfer started" are the same instant - so `READY` means *fetched, handed off, no bytes yet*. `noteDownloadStarted` sets it; the **first byte** (`received > 0`) promotes it to `downloading`. Promoting on a zero-byte progress event would put every file parked behind the speed limiter back under "Downloading" and hide the fetch-ahead buffer the pipeline exists to build.

**"Unavailable" is never "no results."** yt-dlp exits 0 with empty output when throttled. `yt-search` returns `{ok: false, reason: 'unavailable'}` rather than an empty list, because collapsing the two writes "not on YouTube" into folder reports for tracks that are there. `yt-search` returns candidates only; scoring and rejection happen in `yt-fallback.mjs`.

**`ALTERING` markers are not stopwords.** remix/slowed/instrumental/live etc. must disqualify on mismatch in either direction, or the queue takes whichever cut the site ranked first.

**A `folderName` may be a PATH.** Downloading a whole profile writes `<user>/<playlist>/`, so `folderName` can carry a forward slash - always a forward slash, on every platform, because that is the one separator every producer of these strings agrees on. `folderFor()` in `main.js` splits on it and sanitizes each segment *separately*; sanitizing the joined string would turn the separator into an underscore and flatten the tree, and it is the root-containment check, not the character class, that keeps `..` out. `joinFolder()` in `sources.mjs` is the only thing that should build one: it drops empty parts before sanitizing, because `sanitizeFolder('')` is `'Playlist'` and filtering afterwards invents a folder nobody asked for.

**A profile's report is written from the queue, not from the folders.** `profile-report.mjs` turns the controller's records back into "what happened across these forty playlists", and `renderer-integration.mjs` sends it when every track of a profile is terminal. It is keyed on the outcome (`profileSignature`) rather than the profile id, so a retry that turns a missing track into a downloaded one rewrites the file instead of leaving the first, now-wrong answer on disk. The renderer is the only place that knows *why* a track was abandoned and which services it tried, which is the entire reason the file exists.

**Anything the app WRITES goes under `DATA_ROOT`, never `app.getAppPath()`.** `getAppPath()` is the repo in development and `resources/app.asar` once installed - and an asar is read-only, so pointing `state/` or `logs/` at it does not fail loudly, it silently loses the queue, the config, the manifest and the resume data on every launch. `DATA_ROOT` is `app.getPath('userData')` when packaged and the repo otherwise, so a dev run keeps using the state you have been testing against. Reads of `dist/index.html` and `build/tray.png` still go through `getAppPath()`, which is correct - reading out of an asar works.

**Bundled executables must be in `asarUnpack`.** `yt-dlp.exe` and `ffmpeg.exe` cannot be spawned from inside an asar. Both are listed in the `build.asarUnpack` patterns, and `youtube-dl.js` swaps `app.asar` for `app.asar.unpacked` in the path the module reports - checking the file is really there before trusting the swap. Get this wrong and it builds fine and fails at run time, taking out the YouTube fallback, search, and every media link.

**Closing the window hides it; `quitting` is the only "really exiting" flag.** The tray keeps the run alive because a profile download is measured in hours. `mainWindow.on('close')` defers to `quitting`, which is set by `before-quit` and by the tray's own Quit - a second source of truth here would eventually disagree with the download code, which already reads the same flag to decide whether a pause is a shutdown. The tray's status line and Pause item are fed from the renderer over `engine-stats`, because the main process cannot see the controller; with nothing to report it says so rather than inventing a number. `config.closeToTray` turns the whole behaviour off.

**The icon is generated, not stored.** `scripts/make-icon.mjs` draws it and writes the PNG and the multi-size ICO with nothing but `zlib` - so the 16px tray icon and the 256px shortcut cannot drift apart, and there is no binary in the repo that nobody can edit. Change the mark there and re-run `npm run icons`.

**Logging is centralised, not sprinkled.** Four things capture on their own and need no call site to remember them: `ipcMain.handle` is wrapped once, before any handler registers, so every IPC failure and every call over 2s is recorded (successes are not - a line per `cache-get` would be most of the log by volume and none of it by value); `app.on('web-contents-created')` attaches `did-fail-load`, `console-message`, `unresponsive` to every page the app ever creates, so a webview added later is covered the day it is added; `process.on('unhandledRejection')` catches the promises that used to fail invisibly; and `installRendererLogging()` in `src/ui/diagnostics.js` forwards renderer exceptions and `console.error`/`warn` over the same `log` channel. It runs *before* React mounts, because a crash during boot is the one most worth having. `ERR_ABORTED` (-3) on a page load is filtered out: this app navigates away constantly by design, and logging that as a failure would bury the real ones.

**The diagnostics summariser must never silently drop an event it does not recognise.** `levelOf()` reads severity off the event NAME (`.failed`, `.error`, `.blocked`) rather than a level argument, because there are fifty call sites and a level argument would drift. An unknown name is `info` and is still counted - a summary that ignores what it was not taught about is exactly the summary that hides the next bug, and `test/diagnostics.test.mjs` pins that behaviour.

**Main collects and writes the report; the renderer renders it.** `src/engine/diagnostics.mjs` is bundled into the UI by Vite and is NOT shipped as loose files in a packaged build, so the main process cannot import it - it hands over the parsed events and the config, the renderer produces the Markdown, and main writes the file. Keeping the write in main is the same rule as everywhere else here: one writer.

## State on disk (all gitignored, all machine-local)

`state/config.json` (download path, speed limit), `state/queue.json` (resumed on launch), `state/transfers.json` (partly-downloaded files, resumed byte-for-byte on the next launch), `state/manifest.json` (every completed download, keyed by track), `state/profiles.json`, `state/cache/*.json` (scrape results, 7-day TTL). Writes go through a temp file + rename — truncated JSON here loses the queue it exists to protect.
