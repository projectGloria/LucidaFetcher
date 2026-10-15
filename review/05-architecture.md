# Architecture — LucidaFetcher

Reviewed 2026-09-21.

The core architecture is better than most codebases this size. The engine/UI/main split is real and enforced by the test suite; `chain.mjs` turning the attempt order into inspectable data is the right call and the comment explaining why is accurate about what it replaced; generating the injected scorer from the tested functions instead of maintaining a second copy is exactly right, and `test/injectable.test.mjs` defends it properly. The findings below are drift and dead weight, not structural problems.

---

### [Medium] The legacy pre-React UI is still in the tree and still wired to a live IPC handler

**Where:** `index.html` (70KB), `renderer.js` (160KB), `extra-features.js` at the repo root

**Detail:** `main.js` loads `dist/index.html` or the Vite dev server (`main.js:1702-1710`) and `package.json`'s `build.files` does not ship these, so they are not reachable in any build. But:

- `renderer.js:443` is the **only** caller of the `yt-metadata` IPC handler, which is consequently kept registered and unguarded (`03-security.md`).
- `renderer.js` is the only handler of the `throttle-unsupported` channel, which is why its absence from the React UI went unnoticed (`04-ux.md`).
- 230KB of code that greps alongside the live code, so every search for a symbol returns two answers with no indication which one runs.

The pattern here is the real cost: features present in the old UI and dropped in the port are invisible, because the old implementation is still there to find.

**Impact:** Dead channels kept alive, silently lost features, and a search surface that misleads.

**Fix:** Delete all three, or move them to an `legacy/` directory excluded from search. Before deleting, diff the IPC channels each side uses — that diff is the list of features the port dropped.

**Confidence:** Verified

---

### [Medium] Documented mechanisms that do not run

Three pieces of well-commented, tested machinery are unreachable in the shipped app. Each is individually small; together they mean the comments overstate what the code does, which is the one thing that makes this codebase's heavy commenting a liability rather than an asset.

**`unhealthy` store skipping** — `controller.mjs:296-297`. `markServiceUnhealthy`/`markServiceHealthy` have no callers outside tests, so `nextAttempt`'s `skip` set is always empty. Full cost analysis in `02-performance.md`.

**Lucida cascade `alternates`** — `cascade-lucida.mjs:84-88`. The search cascade computes up to 3 acceptable alternate hrefs and returns them with the comment "so a candidate whose stream fails can be followed by the next one". `grep -rn "alternates" src/` finds only the definition; `_navigateAndInject` (`worker.mjs:255-257`) ignores the field and follows only `best.href`. A release page with no usable download control fails the whole store, which is the exact outcome the field was added to prevent.

**The album search variant** — `variants.mjs:43-46`, never constructed because `AddView.toQueueItem` omits the argument. Detail in `01-bugs.md`.

**Fix:** Wire each up or delete it with the comment. The tests that cover them will tell you which is cheaper.

**Confidence:** Verified

---

### [Medium] `main.js` is 1,900 lines carrying about twelve unrelated responsibilities

**Where:** `main.js`

**Detail:** In one file: session logging and log rotation, the IPC instrumentation wrapper, console-spam throttling, five kinds of persistent state, the scrape cache, an HTTP proxy with an allowlist, the Jamendo API client, yt-dlp orchestration, "is it already downloaded" including a folder scanner, two report writers, the diagnostics collector, the download-context registry, the bandwidth limiter, `will-download` handling, the tray, window creation, and a FLAC metadata rewriter.

The section comments are good enough that navigating it is manageable, which is probably why it has not been split. But it has real consequences visible in the findings elsewhere:

- The quit-flush bug (`01-bugs.md`) exists because five independent debounced writers each registered their own state and no single component owns "persist everything before exit".
- `downloadArtwork` has no allowlist while `http-json` and `media-resolve` both do — three outbound-request paths in one file with three different security postures.
- `diagnostics-save` opens a dialog with no parent window while `download-artwork` passes `mainWindow`.

These are consistency failures, and consistency is what a 1,900-line module cannot enforce.

**Fix:** Extract along the seams the section comments already draw — `state.js` (with one `flushAll()`), `logging.js`, `net.js` (one allowlisted fetch helper used by all three call sites), `downloads.js`, `reports.js`, `flac.js`. No behaviour change required; the section boundaries are already correct.

**Confidence:** Verified

---

### [Low] Runtime data is written into the source tree during development

**Where:** `main.js:29` — `DATA_ROOT = app.isPackaged ? app.getPath('userData') : app.getAppPath()`

**Detail:** The rationale is sound and documented (an asar is read-only, so a packaged build must write elsewhere; a dev run should keep the state you have been testing against). The consequence is that `state/` — config, queue, manifest, history, profiles, transfers, and a `cache/` directory of scraped result lists — and `logs/` (13 session files currently) sit in the project directory.

There is no `.gitignore` and the project is not a git repository, so nothing marks these as generated. `lucidafetcherBAK/` — a copy of an old Electron userData directory including `Network/Cookies` and `Local State` — is also in the tree.

**Impact:** If this is ever put under version control, the first commit captures scraped cache data, browsing-shaped state and old cookies. It also makes "what is source here?" a question a newcomer has to work out.

**Fix:** Add a `.gitignore` covering `state/`, `logs/`, `dist/`, `release/`, `node_modules/`, `lucidafetcherBAK/` before initialising a repository. Consider pointing the dev `DATA_ROOT` at a `.dev-data/` subdirectory to make the boundary explicit.

**Confidence:** Verified

---

### [Low] No lint, no type checking, no CI

**Where:** `package.json`

**Detail:** `scripts` has `test`, three Vite scripts, two build scripts and `icons`. There is no linter, no formatter and no type checking. The test suite is genuinely good — 163 tests, dependency-free, and it covers the subtle cases (the injectable-scorer isolation test is excellent) — but it only covers `src/engine/`. `main.js` (1,900 lines), `youtube-dl.js` and the entire React UI have no automated checking of any kind.

Several findings in this review are the kind a linter or `tsc --checkJs` would have surfaced: the unused `markServiceUnhealthy`/`alternates`/`yt-metadata`, the `event` shadowing at `main.js:1500`, the `stackOf` const used by handlers defined above it.

**Impact:** The untested 60% of the codebase is where most of this review's findings are.

**Fix:** ESLint with `no-unused-vars` and `no-shadow` would pay for itself immediately. JSDoc-driven `checkJs` is a bigger lift but the code is already heavily annotated with `@param` blocks.

**Confidence:** Verified

---

### [Low] `engine/index.mjs` does not export `READY`

**Where:** `src/engine/index.mjs:16-18` vs `src/engine/controller.mjs:30`

**Detail:** The barrel exports `QUEUED, SEARCHING, DOWNLOADING, COMPLETED, SKIPPED, CANCELLED` but omits `READY`, which was added later and carries a 10-line comment explaining why it is a distinct, load-bearing state. Consumers importing from the barrel have to compare against the string literal `'ready'` or reach past it into `controller.mjs`.

**Fix:** Add it to the export list.

**Confidence:** Verified

---

### [Low] Two scratch scripts in the repo root are not part of anything

**Where:** `test-str.js`, `test-yt.js`

**Detail:** Not matched by `node --test test/*.test.mjs`, not referenced by any script or import. Their names suggest tests, so they invite someone to run them and draw conclusions.

**Fix:** Delete, or move under `scripts/` with a comment saying what they were for.

**Confidence:** Verified
