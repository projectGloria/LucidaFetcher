# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

LucidaFetcher is an Electron desktop app (Windows-first) that takes a pasted playlist/track link (Spotify, Deezer, SoundCloud, etc.), resolves it to a track list, and fetches FLACs by driving scraper sites (Lucida, Monochrome) inside hidden `<webview>`s, then letting Chromium's download manager save the files.

## Commands

```bash
npm test                                   # node:test over test/*.test.mjs (pure Node, no Electron)
node --test test/pool.test.mjs             # single test file
node --test --test-name-pattern="cancel" test/controller.test.mjs   # single test by name
npm run lint                               # eslint; expected to be zero problems
npm run dev:ui                             # Vite on :5173 (strictPort) - renders against a mock controller in a plain browser
npm run build:ui                           # Vite build of src/ui -> dist/ (what Electron loads)
npm start                                  # electron . (loads dist/, so build:ui first)
npm run test:electron                      # build:ui + scripts/smoke-electron.mjs: isolated real-Electron integration run against a local fixture server; needs ffmpeg on PATH
npm run test:packaged                      # same smoke check against the packaged build
npm run dist:win / dist:portable / pack    # icons + build:ui + electron-builder (output in release/)
```

## Architecture

Three layers, with a hard boundary that the tests depend on:

- **`main.js`** (CommonJS, ~2.5k lines, Electron main process) — owns everything that writes to disk or talks to the OS: `will-download` handling and save-path assignment, the speed limiter / pause / resume of Chromium transfers, transfer resume, the download manifest, persisted queue/config/history/cache/profiles, the JSONL session logger, diagnostics, tray, single-instance lock, and the `http-json` proxy (CORS dodge for e.g. Deezer). The renderer reaches it only through `ipcMain` channels.
- **`src/engine/`** (plain ESM) — all download logic. **Nothing here imports Electron, React, or touches the app window's DOM except via `electron-bridge.mjs`**, which adapts webviews/ipcRenderer to the engine's injected interfaces. That is why the whole attempt flow is testable in Node. Keep it that way.
  - `controller.mjs` — the store: queue, per-track state machine (queued → searching → ready → downloading → …), retries/"Keep trying". One pool task owns a track's *entire* chain so a track stays on one webview for its lifetime.
  - `pool.mjs` — fixed worker slots (slot index ↔ webview), no Electron.
  - `chain.mjs` — the attempt order as inspectable data (`buildPlan` / `nextAttempt` / `advanceAfter`) across stores (`DOWNLOAD_SERVICES`).
  - `worker.mjs` — carries one attempt through one webview; view, IPC and clock are injected.
  - `cascade-lucida.mjs` / `cascade-monochrome.mjs` — scripts injected into the scraped pages. Lucida is two-page (search → release page), so `navigating` is a success outcome.
  - `matching.mjs` — shared title/artist scorer used by both cascades and by `flac-identity.mjs`.
  - `sources.mjs` — link → track list; transports (`fetch`, `httpJson`, `scraper`) are injected.
  - `renderer-integration.mjs` — `startEngine()`: wires Controller + Workers + bridge + persistence inside the renderer.
- **`src/ui/`** (React 19, Vite root) — view layer only. `src/ui/engine.js` subscribes to the engine controller via `useSyncExternalStore` (`useItems`, `useStats`, `useGroups`, …); the engine is never mirrored into React state. Outside Electron (`window.require` absent) it falls back to `mock.js`. Byte-level progress bypasses the store (`useTransferProgress`) because it arrives too often.

### Non-obvious constraints

- **Injected functions must close over nothing.** Cascade scripts are generated with `Function.prototype.toString()` from real module functions. Any reference to a module-level binding breaks once minified ("Se is not defined" shipped once). `test/injectable.test.mjs` re-creates them in an empty scope to enforce this. Functions marked "also runs in the webview" must stay self-contained. `vite.config.mjs` also sets `minify: false` as a second line of defence. Don't turn it back on.
- **`base: './'` in Vite is required**: Electron loads `dist/` over `file://`, so absolute asset paths silently load nothing.
- **Renderer security model is deliberate**: the main window has `nodeIntegration: true`, `contextIsolation: false`, `webviewTag: true` (the renderer `require`s electron, no preload). `main.js` strips Node/preload from every webview it attaches. Don't loosen the webview side.
- **Packaging allowlist**: `package.json` `build.files` lists the engine modules `main.js` dynamically `import()`s (`profile-output`, `flac-identity`, and their transitive imports: `library`, `profile-paths`, `matching`, `m3u8`). If a main-process import gains a new engine dependency, add it there. Otherwise the installed build breaks while dev works.
- **Data location**: `DATA_ROOT` is the repo in dev and `userData` when packaged (asar is read-only). So `state/` and `logs/` in the repo are live runtime data from dev runs. Don't treat them as fixtures, and don't commit them.
- Some reserved-name / path-sanitising rules are duplicated on both sides (`sanitizeFolder` in `sources.mjs` ↔ `WINDOWS_RESERVED` in `main.js`). Change both together.
- **UI tests are coupled to markup.** `scripts/smoke-electron.mjs` and `test/ui-fixture.jsx` drive the real UI by selector and exact text (`.nav-item`, `.topbar button` text such as `Missing` / `Collapse all` (which is why filter counts live in a `data-count` attribute), `.mode-tab`, `#music-search`, `#profile-search`, `label.switch .track`, `#vol`, `.transfer-pct`, `.transport`). `test/ui-reliability.test.mjs` `vm`-evaluates slices of `AddView.jsx` between named functions (`toQueueItem`→`formatDuration`, `previewError`→`withoutExisting`, `downloadProfile`→`queuePlaylist`), so keep those adjacent. Renaming any of these means updating the scripts too.
- Persistence writes are serialized per destination and flushed through a quit/close handshake. New debounced writers must join that flush, not write on their own timer.

## Conventions

- Comments explain *why* the obvious version is wrong, often with dates and concrete failure cases. Match that density and keep existing ones accurate when changing behaviour.
- `catch (e) { /* reason */ }` with an explanatory comment is the accepted idiom for deliberately ignored errors. `no-await-in-loop` is off on purpose (serialized scrapes/writes).
- Lint rules are correctness-only (see `eslint.config.mjs`). Don't add style rules.
- `review/` holds dated audit write-ups (reasoning records, mostly resolved) and `RELIABILITY.md` documents retry/"Keep trying" semantics. Check them before reworking an area; they record why things are the way they are.
- `npm test` / `npm run test:electron` cover controlled fixtures only. They say nothing about whether Lucida/Monochrome markup is still current.
