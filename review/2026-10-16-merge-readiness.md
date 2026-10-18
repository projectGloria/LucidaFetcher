# LucidaFetcher + SpotiFLAC: merger readiness analysis

Analyzed 2026-10-16. This is a preparation document, not an implementation or a claim that every upstream service currently downloads successfully.

## 1. Scope and pinned evidence

| Component | Examined version / evidence |
| --- | --- |
| LucidaFetcher | Local `main` at `095790cb00014a68418f25443e4dc23e64ff85bc`; package version 1.0.0. Initial Git status showed only the user's untracked `SpotiFLAC.exe`. |
| SpotiFLAC | Release v7.2.2, commit `90f51a4da5bff0ec51183dd5e789a78e6f6a009d`. Its tag points to the same commit as the source snapshot retrieved for analysis. |
| Local executable | 7,614,976 bytes; SHA-256 `6f074d70ff7a7c8e005bb0dec24dcca1b878435ad48e3230d0bf7f06f8b99be7`. Both size and digest match GitHub's v7.2.2 Windows release asset. Windows version-resource fields are empty; Authenticode reports unsigned. Matching the release establishes correspondence to that published asset, not a security audit. |
| Monochrome | Source snapshot `a3c86df0436a3eedc341ab5163fc5ee6b1688b5d`; inspected its current web page, served JS bundle, API/download modules and declared license. Source snapshot and deployed build were not proven identical. |
| Lucida | Current public home and Qobuz search HTML, plus the local app's complete integration flow. Public downloader-library source could not be retrieved through the attempted web/raw URLs; server internals remain outside the verified scope. |

Upstream snapshots and HTTP evidence were downloaded under `%TEMP%/lucidafetcher-spotiflac-analysis`, outside this repository. They are disposable research copies. The only repository addition made for this analysis is this document. No executable was launched, music downloaded, user library scanned, or application state migrated.

Primary upstream references:

- [SpotiFLAC v7.2.2 release](https://github.com/spotbye/SpotiFLAC/releases/tag/v7.2.2)
- [Release asset metadata, including digest](https://api.github.com/repos/spotbye/SpotiFLAC/releases/tags/v7.2.2)
- [Pinned Wails entry point](https://github.com/spotbye/SpotiFLAC/blob/90f51a4da5bff0ec51183dd5e789a78e6f6a009d/main.go)
- [Pinned app methods and download request/response](https://github.com/spotbye/SpotiFLAC/blob/90f51a4da5bff0ec51183dd5e789a78e6f6a009d/app.go)
- [Pinned SpotiFLAC frontend download orchestration](https://github.com/spotbye/SpotiFLAC/blob/90f51a4da5bff0ec51183dd5e789a78e6f6a009d/frontend/src/hooks/useDownload.ts)
- [Pinned Monochrome stream client](https://github.com/monochrome-music/monochrome/blob/a3c86df0436a3eedc341ab5163fc5ee6b1688b5d/js/tracks-api.js)
- [Pinned Monochrome audio/download API](https://github.com/monochrome-music/monochrome/blob/a3c86df0436a3eedc341ab5163fc5ee6b1688b5d/js/api.js)
- [Lucida public site](https://lucida.to/)

## 2. What the existing app actually does

### Runtime and ownership

LucidaFetcher is an Electron desktop app with React 19 and Vite. `main.js` is CommonJS; the engine is ESM. The package declares Electron 44 and Vite 8. `src/ui/App.jsx` exposes Downloads, Add music and Settings. A normal browser preview uses a mock controller, so a successful preview alone does not test downloading.

There are three important execution environments:

1. **Local React renderer:** owns the controller, search scheduling, import flow and persistence snapshots. It currently has Node integration enabled and context isolation disabled.
2. **Remote webviews:** one offscreen, rendered browser surface per search worker, plus a separate import scraper. Remote views have Node integration disabled and context isolation enabled by the main process. They are deliberately outside React's managed tree so component renders do not destroy active work.
3. **Electron main process:** owns Chromium downloads, destinations, filesystem writes, manifests, resume records, validation/finalization, HTTP proxying, artwork, logging, diagnostics and shutdown flushing.

`main.js` is now over 2,500 lines. Older reviews describe earlier versions and fixed defects; they are useful history, not a current outstanding bug list.

### Metadata import is separate from audio acquisition

`src/engine/sources.mjs` classifies input and produces metadata. Spotify playlist, album and track reads use the public embed page's `__NEXT_DATA__`; profile discovery uses a real Spotify page, consent handling and scrolling. Deezer imports/search use its public API through a bounded main-process JSON proxy, including pagination.

`spotify-metadata.mjs` shares pacing, duplicate-request suppression, retries and cooldowns between metadata and artwork requests: two concurrent requests, 500 ms launch spacing, three attempts, 20-second fetch deadlines and Retry-After handling. Track metadata caches live longer than playlist/album caches. These controls should survive the merger.

Text search in Add music uses Deezer metadata. Spotify is an input/catalog identity here, not the audio transport. Importing a Spotify item does not download Spotify audio.

Ordinary queue records carry title, artist, album, duration, artwork and destination/group information. Profile records additionally maintain canonical track identity and playlist membership. The two paths currently preserve different amounts of identity data; see section 5.

### Download planning and source matching

`chain.mjs` builds ordered attempts for explicitly enabled services: Qobuz, Tidal, Deezer, Amazon, Yandex and Monochrome. The first five go through Lucida; Monochrome has its own worker path. Each service gets up to two generated query variants by default. Enabled order is significant. Fresh configuration defaults to Amazon, not to trying all six automatically.

`variants.mjs` generates alternative wording. `matching.mjs` compares titles, credited artists and duration, preserves meaningful title order and rejects different recording variants such as remixes, live versions, slowed edits and covers. The same scorer is injected into both sites rather than maintained as separate copies. Injected functions must remain self-contained when serialized; the production build currently disables minification as additional protection.

YouTube and SoundCloud acquisition are explicitly disabled by the active download plan/worker/main-process policy. Legacy helper modules and icons do not make them active sources. The merger should preserve FLAC-only behavior unless the product requirements later change.

### Lucida browser flow

`worker.mjs` opens `https://lucida.to/search?query=...&service=...`, registers a per-webContents download context before navigating, and injects `cascade-lucida.mjs`.

The cascade ranks `.search-result` candidates, visits a matching release, chooses a matching track row and clicks its download control. It distinguishes missing results, backend errors, missing controls and successful clicks. It can use alternate release pages rather than abandoning a store after one dead release page. Region errors trigger navigation using a currently offered country option rather than a hard-coded region.

The click is only an intermediate event. The worker waits for an actual Chromium download start. Main then claims the correct track context, checks source/format policy, reserves a collision-safe destination and owns the transfer.

### Monochrome browser flow

The app currently opens `https://monochrome.st/search/...` and injects `cascade-monochrome.mjs`. It ranks rows, opens their context menus and chooses Download. A candidate may require stream resolution, fetching and browser-side remux/metadata work before an `<a download>` starts Chromium's final download.

The cascade observes download anchor clicks and error notifications, tries up to four ranked candidates and has bounded polling budgets. This explains why a track can spend time preparing before file-transfer progress appears. It also means Electron pause/byte progress may cover only the final browser download, not every byte the website fetched while preparing its blob.

### Queue, transfers and library output

`controller.mjs` owns status transitions, attempt history, service health and retry policy. States include queued, searching, ready, downloading, completed, skipped and cancelled. `pool.mjs` limits active search workers. Transfers can detach from their webview at download start, freeing searches while main receives bytes. Defaults are three search slots and six detached transfers; six is a detached-transfer allowance, not necessarily a strict cap on all active network work.

Pause, cancel, restart recovery and Keep trying already have explicit behavior. Keep trying retries missing tracks with backoff from 30 seconds to five minutes, excluding completed/cancelled work. Search scheduling and actual transfer control are separate responsibilities.

`main.js` accepts enabled FLAC sources, checks FLAC structure/completeness and available embedded identity, handles interrupted transfers and stalled downloads, repairs oversized artwork and records successful files. Missing embedded artwork is rejected; downloading a separate `cover.jpg` does not satisfy that embedded-art requirement. Unsuccessful final validation must not become a manifest entry.

Profile libraries deduplicate shared tracks while preserving each playlist's membership/order. `profile-output.mjs`, `profile-paths.mjs`, `library.mjs` and `m3u8.mjs` create `Tracks/`, `Playlists/`, `library.json`, artwork and M3U8 output. Existing files are checked before reuse. Writes serialize and use atomic replacement where implemented; shutdown coordinates renderer snapshots and main-process finalization.

Development state lives under the app directory; packaged state lives under Electron userData. Configuration, queue, manifest, history, profiles, transfers, cache and diagnostic logs must be considered separately in a future migration.

## 3. How SpotiFLAC works

### Application boundary

SpotiFLAC v7.2.2 is a Go 1.26 + Wails 2.13 desktop app with a React/TypeScript/Vite frontend. Wails embeds the built frontend and binds an `App` object into that webview. Its frontend calls generated methods such as `GetSpotifyMetadata`, `GetStreamingURLs`, `DownloadTrack`, queue persistence and progress methods.

The inspected entry point has no application CLI argument parser, stdin job protocol or public HTTP service. These Wails bindings belong to its own window. The stock executable is useful as a reference and standalone app, but is not an established worker interface for Electron. An internal Wails transport would not be a supported integration contract.

The current Electron packaging allowlist also does not include `SpotiFLAC.exe`. Merely placing the file in the root neither wires it into the runtime nor ships it in an installer.

### Metadata and cross-service resolution

The Go metadata code initializes a Spotify web-player client, obtains anonymous client/session information and issues persisted GraphQL queries. The source includes token caching and time-based initialization logic. This is a different import path from LucidaFetcher's embeds and has its own dependency on Spotify web-player changes.

Supported source handlers include track, playlist, album, artist and artist discography. That does not replace LucidaFetcher's user-profile playlist discovery, which is a separate feature.

Link resolution uses Spotify identity/ISRC and configurable Songstats or Deezer/Songlink lookup, with optional resolver fallback. It produces Tidal/Amazon URLs and ISRC data; Qobuz acquisition can resolve by ISRC. Direct provider URLs are also accepted on relevant download paths. A generic title/artist pair is not equivalent to a fully resolved Spotify/ISRC request.

### Download and fallback ownership

`App.DownloadTrack` takes an explicit service (`tidal`, `qobuz` or `amazon`), rich metadata, provider URLs/Spotify ID/ISRC, quality, destination and tagging options. It creates/updates queue state, invokes the relevant Go downloader, validates duration, handles cancellation, embeds metadata/lyrics and can perform optional conversion/resampling.

**The top-level automatic ordering across Tidal, Qobuz and Amazon is in `frontend/src/hooks/useDownload.ts`.** That frontend resolves links, interprets settings/quality and loops through the selected service order. Calling the Go method with `service: "auto"` is not equivalent: its switch rejects unknown services. Provider downloaders also have fallback options of their own. The new app must specify which fallbacks it owns and record what actually ran.

Tidal, Qobuz and Amazon use third-party/community services, configurable API paths where supported, stream/container handling and metadata writers. The backend includes community sessions, cooldowns and Retry-After behavior. These dependencies can overlap with other tools' infrastructure, so three application adapters do not establish three independent upstream sources.

### Features worth reusing

- Richer Spotify catalog and discography metadata.
- Identity-driven provider resolution using IDs/ISRC.
- Direct Go download implementations and source provenance.
- Native FFmpeg/FFprobe integration and container processing.
- Detailed tags, cover embedding, lyrics and filename templates.
- Optional ReplayGain, conversion, resampling, inspection and library utilities.

Not all of these belong in the first merged release. Conversion, resampling and Atmos paths would need an explicit product decision because the current app enforces FLAC-only acquisition. They should not silently alter its policy.

### State and concurrency constraints

SpotiFLAC stores application files under the user's `.spotiflac` directory and uses bbolt for its persistent queue. LucidaFetcher's queue/history/manifest formats are different; the new application needs its own state owner.

`backend/progress.go` contains process-wide current item/progress/speed/downloading state. `backend/download_cancel.go` shares a cancellation context across active download scopes. Its frontend batch loops process tracks sequentially within a batch. Mutex protection of globals does not make these fields independent per job.

Consequently, running several backend jobs in one process without refactoring risks incorrect attribution and broad cancellation. A first adapter should serialize that backend's work; proper parallelism requires per-job progress, context, cancellation and output ownership. Existing frontend pause behavior must also be distinguished from pausing a live HTTP transfer.

## 4. What current upstream checks establish

### Lucida

PowerShell HTTP requests retrieved real Svelte-rendered HTML, despite the web reader receiving a 403 on its initial homepage request. The offered services match the site's current service selector, with additional services beyond those enabled in this app.

A read-only Qobuz search without country returned `Invalid country for qobuz` and offered NL. Repeating with `country=NL` returned a Qobuz catalog/search HTTP 403 error in the page's data. This is a point-in-time observation for that query/provider, not proof that Lucida as a whole is offline. The local cascade already handles invalid-country selection and backend errors, so the first response alone is not an uncovered bug.

### Monochrome

The current source contains a `TracksStreamerAPI` that searches `tracks.monochrome.st/search?q=...`, normalizes catalog results, resolves external metadata and generates direct `/track/{id}` FLAC stream information. Other code retains additional stream/manifest and processing paths. Its instance documentation explicitly warns that it is outdated.

The deployed JS bundle contains `tracks.monochrome.st` and the notification/menu/duration markers used by the existing scraper. This supports investigating a direct adapter and continued DOM compatibility, but does not establish that every selector, route or stream currently works. No audio request was made. Treat stream IDs as opaque strings; the source handles IDs larger than JavaScript's safe integer range.

## 5. Concrete issues to design around

| Finding | Evidence and merger consequence |
| --- | --- |
| Loose imports drop provider identity | `AddView.jsx: toQueueItem` does not accept/copy `trackId` or `isrc` and creates a destination/title/artist key. Metadata readers often have those IDs, but this ordinary queue path loses them. Profile import retains them. Normalize every import before adding ID-driven providers. |
| Service means more than one thing | Existing steps distinguish Lucida/Monochrome through `source`, but many records, health maps and reports key on `service` alone. Add explicit metadata origin, adapter/route, catalog service and actual audio provenance. A Lucida Qobuz outage must not automatically disable a distinct SpotiFLAC Qobuz route. |
| Two queue owners would conflict | Each application has scheduling, progress, persistence, existing-file checks and history. The merged product should own these centrally and treat Go as a provider worker. |
| Go is not currently a parallel job service | Global progress/current item/cancellation require serialization first or a job-scoped refactor. Cancellation must target one requested item reliably. |
| Existing file ownership is different | Electron reserves collision-safe paths; SpotiFLAC constructs its own filenames and can skip expected files over 100 KiB. Go should write to an app-assigned staging location, with final acceptance and placement owned centrally. |
| Validation can lose independent evidence | SpotiFLAC writes imported Spotify metadata onto downloaded audio. Rechecking those rewritten tags alone cannot prove the source was the right recording. Capture provider identity and duration before rewriting, then validate the final artifact as well. Existing FLAC checks also tolerate missing identity tags; they are not audio fingerprinting. |
| Quality names are not portable | Tidal tokens, Qobuz numeric quality values and Amazon options differ. Model requested minimum quality separately from measured container/codec/bit depth/sample rate. A FLAC extension or upstream label alone cannot prove original losslessness. |
| Pause/resume differs by transport | Chromium partial-download recovery cannot be reused automatically for Go HTTP jobs or browser-prepared blobs. Expose provider capabilities and define restart behavior explicitly. |
| Automatic fallback is split across layers | Top-level SpotiFLAC provider order is frontend code, with additional downloader fallback settings. Centralize policy and prevent untracked retries or a fallback that violates selected quality/source rules. |
| Main process needs clearer boundaries | Extract state, network access, provider transport, validation/finalization and diagnostics from the current large `main.js`. A new UI should use a narrow preload API with context isolation. |
| Packaging currently omits the executable | A future helper needs explicit packaged resources, executable-path resolution, version/protocol checks and lifecycle handling. |
| Old review findings are historical | Repository reviews explicitly record completed fixes. Verify current code/tests before treating those older lists as outstanding work. |

## 6. Recommended architecture for the new app

This is an engineering recommendation based on the inspected code, not a user-selected framework decision.

Use a new React/TypeScript interface in an Electron shell, a single application orchestrator, and a source-built Go helper for the selected SpotiFLAC capabilities. Retain Lucida/Monochrome browser adapters while evaluating direct Monochrome acquisition. Electron is the lowest-friction first shell because the existing browser automation and Chromium download plumbing already depend on it. Moving everything to Wails would require replacing that behavior and should be a deliberate larger rewrite.

```text
New React UI
    -> narrow preload API
    -> application orchestrator + persistent job store
         -> metadata import/resolution adapters
         -> provider plan + shared matching/quality policy
              -> Go helper: SpotiFLAC Tidal / Qobuz / Amazon
              -> Lucida browser workers
              -> Monochrome browser worker / evaluated direct adapter
         -> staging -> identity/format checks -> tags/art -> final placement
         -> library, playlists, reports and history
```

The Go helper should have a versioned, structured local protocol, preferably JSON messages over stdio with logs kept off the protocol stream. Include request/job IDs on every response and event. Essential operations are capabilities/handshake, metadata, resolution, download, progress, cancellation and shutdown. Declare pause/resume/parallelism support honestly. A helper crash must leave a recoverable job state and must not mark a file complete.

The helper must be built from selected source, with Wails dialogs/events and global settings isolated behind interfaces. Merely importing the current backend still pulls desktop-facing helpers into the package; a clean worker boundary requires extraction. Its Go build and FFmpeg/tagging dependencies need a reproducible packaging check. The current environment has bundled Node/Git but no Go or FFmpeg found on PATH.

Keep one canonical track model with provider ID aliases, ISRC, title/version, structured artists, album, duration and artwork. Keep destination, playlist membership and job state separate from recording identity. Preserve profile deduplication without collapsing distinct versions or different destination policies. Any enrichment from a temporary title-based key to an ISRC key needs atomic alias/membership updates.

Represent attempts with both route and service, for example `spotiflac/tidal`, `lucida/tidal`, `monochrome/direct` and `monochrome/browser`. Health/cooldowns should follow the actual failing dependency, with room to group shared upstream failures. Keep source order configurable; do not hard-code a final order before checking coverage and failure behavior.

Use one file finalizer for all transports. Providers return a staged artifact and original provider evidence. The app validates identity, duration, container and requested quality, applies allowed metadata/artwork changes, places the file safely and only then commits library/history success. Do not allow both Electron and Go to write the same final target.

## 7. Implementation sequence when building is requested

1. Create the new app shell and shared track/job/provider contracts, preserving the current application as a reference. Select its name, interface direction and initial feature scope separately.
2. Carry all provider IDs/ISRC through import and persistence; add route-aware attempts, provenance and typed failure outcomes.
3. Extract the selected SpotiFLAC backend into a versioned helper. Initially run one Go job at a time. Verify its real protocol, progress, cancellation and crash behavior.
4. Adapt existing Lucida/Monochrome workers to the same job contract and common artifact finalizer. Evaluate Monochrome's direct path with controlled live checks before replacing browser automation.
5. Add one user-facing queue and one fallback policy. Preserve profile libraries, missing-track retries, artwork, manifests and reports. Keep broader audio utilities optional for a later scope.
6. Package the helper and required media tools explicitly; isolate the new app's state directory. If importing old state is desired, implement a versioned, copy-based migration with backups and file revalidation.

Meaningful acceptance checks: original vs remix, missing metadata, incorrect duration, duplicate recording across playlists, path collisions, disallowed format/quality, one-provider failure with successful fallback, isolated cancellation, provider cooldowns, shutdown during finalization, helper crash and packaged execution. User-level pause must have a consistent documented effect even when a provider can only stop future jobs.

## 8. Verification and remaining uncertainty

Executed all current `test/*.test.mjs` files with bundled Node v24.19.0 and the dot reporter; the test process exited 0. There are 24 test files. These cover the dependency-free engine and relevant mocked/main-process regressions; the historical 203/242 counts in review notes were not substituted for a new count.

Did not install dependencies or run lint/build/Electron smoke checks: this checkout currently has neither `node_modules` nor `dist`, and the requested work is preparation. No Go build was attempted. No full GUI behavior, provider audio transfer, long-running resource behavior or end-to-end installer behavior has been verified in this phase.

SpotiFLAC's pinned source declares MIT; preserve its copyright/license notice when reusing it. Monochrome's pinned repository declares Apache-2.0; carry the applicable notices if its code is copied. Lucida library licensing/dependency suitability still needs inspection if integrating that library directly instead of retaining the current web adapter. Third-party dependency and bundled-media-tool notices must be inventoried when packaging; repository license labels alone do not settle that inventory.

The merger is technically feasible. The key preparation result is a concrete separation between reusable product behavior, provider-specific acquisition and responsibilities that must have one owner in the new app. The stock SpotiFLAC executable remains a verified release reference; source-level integration is the practical route to a coherent single application.
