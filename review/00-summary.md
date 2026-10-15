# Codebase review — LucidaFetcher

> **Status: all findings fixed (2026-09-21).** The reports below are kept as the
> reasoning record — what was wrong and why it mattered — not as an open list.
> Verified after the fixes: `npm run lint` clean, 169 tests pass (6 new
> regression tests), `npm run build:ui` succeeds, and the app launches and
> writes a session log with zero error events.
>
> Two fixes go beyond what the reports describe, because running the app
> surfaced more than reading it did:
> - `advanceAfter`'s "skip the rest of this dead store" branch was *also* dead —
>   it was written against an outcome name (`service-unavailable`) that nothing
>   emits. Now matched to the outcomes the worker really produces.
> - `pruneManifest` needed a stronger guard than "does the download root exist".
>   Launching the app during verification pruned 997 of 997 manifest entries
>   against a present-but-empty music folder. It now refuses to prune when most
>   of a sizeable manifest is missing.

Reviewed 2026-09-21. Not a git repository, so there is no commit to pin this to; the tree as it stood on that date, `package.json` version 1.0.0. Whole codebase, excluding the legacy root UI (read only enough to establish it is dead), `lucidafetcherBAK/`, and generated/state directories.

## Scope and method

**Read in full:** `main.js` (1,900 lines), all 17 modules under `src/engine/`, `youtube-dl.js`, `src/ui/App.jsx`, `engine.js`, `diagnostics.js`, `history.js`, `vite.config.mjs`, `package.json`.

**Read partially / targeted:** `src/ui/views/AddView.jsx` (691 lines — the first 120 plus greps for the queue-item builder and the import flow), `SettingsView.jsx`, `QueueView.jsx`, the test suite, `scripts/`.

**Skimmed by grep only:** `index.html`, `renderer.js`, `extra-features.js` at the repo root — established as the superseded pre-React UI and reviewed only for what still reaches live code.

**Tools run:** `npm test` (163 pass). No linter, type checker or `npm audit` is available — `node_modules/` is not installed and the project has no lint or typecheck configuration. Two findings were confirmed by writing and executing standalone repro scripts against the engine modules rather than by reading alone.

## Verdict

This is a well-built codebase with a small number of serious defects concentrated in exactly the places the tests do not reach. The engine layer is genuinely good — the Electron-free boundary is real and enforced, `chain.mjs` modelling the attempt order as inspectable data is the right decision, and generating the injected page scorer from the tested functions (with `test/injectable.test.mjs` defending it against minification) is a solution better than the problem usually gets. The commenting is unusually high-value: it records why the obvious version is wrong, with dates and concrete cases.

The problems cluster in three places. **`main.js` is doing twelve jobs**, and the consistency failures that follow are visible: three outbound-request paths with three different security postures, five debounced writers with no owner for "flush before exit". **The React port dropped things the old UI did**, and nobody noticed because the old UI is still in the tree to be found by grep. And **three well-documented, tested mechanisms never actually run** — the unhealthy-store skip list, the cascade's alternate candidates, the album search variant — which means the comments currently describe an app somewhat better than the one that ships.

Two findings deserve fixing before anything else: the concurrency slider can put two download chains on one webview (verified with a repro; causes silent file/metadata corruption), and the artist-match gate switches itself off for any artist whose name tokenises to nothing — MØ, AC/DC, The xx — which is precisely the wrong-file-downloaded outcome the entire scorer exists to prevent.

## Top issues

| Severity | Finding | File | Category |
|---|---|---|---|
| High | Concurrency slider puts two chains on one webview and one download context | `src/engine/pool.mjs:36` | [Bugs](01-bugs.md) |
| High | Debounced queue/manifest/transfer writes are not awaited on quit | `main.js:1866` | [Bugs](01-bugs.md) |
| High | Artist gate disables itself for short artist names (MØ, AC/DC, The xx) | `src/engine/matching.mjs:103` | [Bugs](01-bugs.md) |
| High | Diagnostics report leaks the Jamendo client ID and signed download URLs | `src/engine/diagnostics.mjs:186` | [Security](03-security.md) |
| Medium | No single-instance lock — two instances clobber each other's state | `main.js:1830` | [Bugs](01-bugs.md) |
| Medium | TLS verification disabled on every yt-dlp invocation | `youtube-dl.js:73` | [Security](03-security.md) |
| Medium | `downloadArtwork` fetches an unvalidated URL, unbounded, unchecked type | `main.js:1406` | [Security](03-security.md) |
| Medium | Unhealthy-store skip list is never populated — dead stores cost full timeouts per track | `src/engine/controller.mjs:296` | [Performance](02-performance.md) |
| Medium | `diagnostics-collect` reads the whole log synchronously and ships every event over IPC | `main.js:1113` | [Performance](02-performance.md) |
| Medium | Speed limiter can switch itself off with no way for the user to find out | `main.js:1340` | [UX](04-ux.md) |
| Medium | A boot failure leaves the app on the splash screen forever | `src/ui/App.jsx:28` | [UX](04-ux.md) |
| Medium | Legacy UI still in tree, keeping a dead unguarded IPC handler alive | `renderer.js:443` | [Architecture](05-architecture.md) |

## Counts

| Category | Critical | High | Medium | Low |
|---|---|---|---|---|
| Correctness | 0 | 3 | 7 | 4 |
| Performance | 0 | 0 | 3 | 3 |
| Security | 0 | 1 | 3 | 2 |
| UX | 0 | 0 | 3 | 4 |
| Architecture | 0 | 0 | 3 | 4 |
| **Total** | **0** | **4** | **19** | **17** |

## Suggested order

1. `Pool.setConcurrency` slot derivation, and commit the slider on release rather than per step — one bug, two independent fixes, both small.
2. The artist-gate fallback in `scoreWith`. Keep it free of module-scope references or `test/injectable.test.mjs` will fail, which is the test doing its job.
3. Flush state on `before-quit` with `preventDefault`.
4. Stop logging config *values* in `set-config`, and scrub the raw tail in the diagnostics report.
5. Remove `noCheckCertificates`, add an allowlist and a size cap to `downloadArtwork`.
6. Delete the legacy root UI, and with it `yt-metadata` — then diff the IPC channels to recover what else the port dropped (`throttle-unsupported` is one; there may be more).

## Blind spots

Being explicit about what this review does **not** cover:

- **Nothing was run.** `node_modules/` is not installed and there is no build, so the app was never launched. Every finding involving Electron runtime behaviour — `will-download` ordering, whether Chromium uniquifies a path passed to `setSavePath`, whether `item.getFilename()` can contain separators, actual quit-sequence timing — is reasoned from source and the documented API, not observed. These are marked `Probable` or `Needs check` rather than `Verified` in the individual reports.
- **No dependency audit.** `npm audit` could not run. Electron 44, Vite 8, React 19 and `youtube-dl-exec` 3.1.13 were not checked against advisories, and the bundled yt-dlp/ffmpeg binary versions were not inspected.
- **`AddView.jsx` was not read in full.** 691 lines, of which I read roughly the first 120 plus targeted greps. The profile-import flow, the set/album modal and the search-results UI had a lighter pass than the rest; there may be findings there I did not reach.
- **`QueueView.jsx`, `TrackRow.jsx`, `DownloadDock.jsx` and `styles.css`** were checked for specific behaviours only, not reviewed systematically. No accessibility review was performed.
- **The cascade scripts were read but not exercised against real pages.** Whether the selectors in `cascade-lucida.mjs` and `cascade-monochrome.mjs` still match the current lucida.to and monochrome.tf markup is unknowable from here, and it is the single most likely source of live breakage in an app built on scraping.
- **No measurement.** Every performance finding is a reasoned cost, not a profile. The `diagnostics-collect` and startup-stat costs in particular scale with data I cannot see (session length, manifest size).
- **Windows-specific behaviour** (reserved device names, path semantics, FLAC parsing in Explorer) was reasoned about but not tested on this machine.
