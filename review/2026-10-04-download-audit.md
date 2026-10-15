# Download and correctness audit — 2026-10-04

Reviewed the current source tree and the existing Windows app archive. There is no Git repository metadata in this directory, so this review is pinned to the files reviewed rather than a commit. Application version: 1.0.0.

**13 actionable findings: seven P1 and six P2.** P1 means a high-impact defect to address before relying on large downloads; P2 means a normal-priority correctness defect. These are new findings against the current tree, not a repetition of the resolved September review.

This report records the original review. The subsequent authorized fixes address all 13 findings; the sections below retain the original diagnosis. `review/download-audit-repros.mjs` now runs the regression tests instead of asserting the old defects. Verification uses temporary fixtures and does not change the user's queue, configuration, downloads, or library.

## Fixes applied

| Finding | Resolution |
| --- | --- |
| 1. Incomplete FLAC marked finished | Restore consults interrupted transfers first and disables filename scanning. Recorded completions require their saved length, FLAC metadata/audio-frame structure, and embedded artwork. Import scans require exact artist/title agreement and exclude interrupted paths. |
| 2. Wrong song alternates | Both recall and precision must agree on the recording title, including edit/version words; Lucida's alternate list uses that same gate. |
| 3. Short and Unicode matching | Short titles are retained; Unicode scripts and non-Latin combining marks remain intact. Empty normalized artist names no longer bypass artist validation. |
| 4. Profile restart structure | Version 4 snapshots persist canonical tracks, profiles, and playlist memberships separately, including completed tracks. Legacy display-row snapshots migrate back into that model. Resumed downloads update canonical profile records. |
| 5. Missing packaged modules | The archive includes the profile output helper and every runtime dependency. A packaged archive integration check loads its built UI and exercises library IPC. |
| 6. Provider health poisoning | A track's unavailable stream advances that track's chain without marking the provider globally unhealthy. |
| 7. Wrong completion filename | Download completion reports the basename of the actual reserved save path and the final on-disk byte count. |
| 8. Missing library files trusted | Library reads validate contained Tracks paths, byte counts, FLAC structure and artwork before marking entries downloaded. Missing/corrupt files return to the download queue. |
| 9. Shared tracks omitted | Each profile's library is built from playlist membership. Shared audio is copied into that profile's Tracks folder, protecting existing files and active-transfer reservations. |
| 10. Artwork removed | Oversized PICTURE blocks are resized and re-encoded as JPEG; the metadata block remains and audio frames are copied unchanged. Decode/repair failures preserve the original file. |
| 11. Playlist names collide | Playlist filenames include a stable ID suffix and are resolved case-insensitively. Library and M3U writes are serialized together and participate in quit flushing. |
| 12. Frozen profile progress | Derived playlist rows read byte progress directly from canonical records; the dock deduplicates shared transfers and React rows have unique membership keys. |
| 13. Unsupported advertised links | Spotify and Deezer single-track links now resolve metadata, artwork and duration. The paste field accurately advertises Spotify/Deezer links; unsupported Lucida release URLs are no longer advertised. |

Final verification results are recorded after the original findings.

## Original review verification and limits

- `npm test`: **218 passed**, zero failures.
- `npm run lint`: passed with no reported problems.
- `npm run test:electron`: passed, including production build, actual webview injection, automatic retry, concurrent distinct save paths, FLAC byte integrity, pause/resume, disposal, and quit persistence.
- `node review/download-audit-repros.mjs`: **13 defect reproductions confirmed**. This is an audit harness whose assertions describe the current defects, not a regression suite asserting desired behavior.
- Inspected `release/win-unpacked/resources/app.asar`: its main process matches the current `main.js`, but the two profile-library engine modules it imports are absent.
- An additional isolated Electron probe started a slow local download, paused it after receiving 278,528 bytes out of 10,000,000, and inspected the actual save path. The partial file already existed under the final `.flac` filename and began with `fLaC`. This confirms the filesystem premise of finding 1.
- Read the queue/controller/pool, transfer bridge, worker, both injected cascades, matching and identity helpers, import flows, persistence, profile/library/M3U output, and relevant React controls. Also checked the two available session logs by aggregating outcomes without publishing URLs or personal track data.
- Live provider searches could not be read through the web tool. This is **not evidence that either provider is down**. Current Lucida/Monochrome markup, real catalog coverage, and long-running remote transfers remain unverified. Controlled integration success does not establish those properties.

Electron's documented [interrupted-download API](https://www.electronjs.org/docs/latest/api/session#sescreateinterrupteddownloadoptions) creates an interrupted item which starts when resumed. The review's restart findings concern the application's checks and persistence before that API is reached.

## P1 findings

### 1. Startup treats incomplete FLAC downloads as finished and bypasses resume

**Locations:** [main.js:988](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/main.js:988>), [main.js:993](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/main.js:993>), [renderer-integration.mjs:344](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/src/engine/renderer-integration.mjs:344>).

`restore()` forces a folder scan, then discards entries with `checks[i].done` before consulting their resumable-transfer records. The scan validates only the first four bytes and matches title tokens against filenames. It does not exclude partial paths recorded in `transfers.json`, compare the received size against the expected size, check the artist, or establish that the FLAC is complete.

**Trigger:** Quit or crash while downloading a track with at least two title tokens. Chromium has already created `Artist - Long Song.flac` and written its header. On restart that partial matches the scan and the queue item is omitted as `alreadyDone`, even though the transfer is resumable. A wrong artist's similarly named file can cause the same omission.

**Evidence:** The source reproduction marks a four-byte `fLaC` file as done. A separate real Electron probe confirmed that partial bytes are written to this final save path, rather than a separately suffixed file the scan would exclude.

**Impact:** The app leaves a truncated file on disk and silently stops downloading the requested song.

**Fix:** Give recorded incomplete transfers precedence over scan hits; exclude their paths from completed-file candidates. Require evidence of completion for a scan hit and match recording/artist identity. A magic prefix alone is not a completion check.

### 2. Lucida alternates can download a different song or edit

**Locations:** [cascade-lucida.mjs:91](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/src/engine/cascade-lucida.mjs:91>), [matching.mjs:140](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/src/engine/matching.mjs:140>), [worker.mjs:251](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/src/engine/worker.mjs:251>).

The title acceptance gate checks recall and artist agreement, while precision affects ranking only. Lucida accepts every passing result as a fallback release. Unlike Monochrome, it does not restrict alternates to the same normalized title as the chosen recording.

**Trigger:** Search for `Fetish` by Obzkure. An exact hit ranks first, but `Money Fetish` also passes. If the exact release page fails, the worker navigates to the different song and downloads it. `Fetish (Club Mix)` also passes because `club` is not an altering marker and `mix` is discarded.

**Evidence:** The real generated Lucida script returns the different song's URL in `alternates`; both incorrect candidates pass the shared scorer in the audit harness.

**Impact:** A valid FLAC of the wrong recording can be saved under the requested track's manifest key. Later retries then consider the request satisfied.

**Fix:** Restrict fallbacks to the requested recording, including cut/version agreement, and require a stronger identity check for the initial candidate as well. Duration, ISRC, and release metadata already available from imports can provide additional evidence. Adding a precision threshold alone needs care because legitimate release labels contain extra words.

### 3. Short/Unicode titles never match; Unicode artist names disable the artist gate

**Locations:** [matching.mjs:52](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/src/engine/matching.mjs:52>), [matching.mjs:59](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/src/engine/matching.mjs:59>), [matching.mjs:80](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/src/engine/matching.mjs:80>), [matching.mjs:126](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/src/engine/matching.mjs:126>).

Normalization removes non-ASCII letters, and tokenization removes words shorter than three characters and stopwords. An empty title token list always returns a failing score. The short-artist fallback also uses this ASCII normalization; a credited artist written entirely in Japanese, Cyrillic, Arabic, or Korean can normalize to nothing and receive the uncredited-artist free pass.

**Evidence:** Exact candidates for `Go`, `The xx`, and `夜に駆ける` fail. `First Love` requested with artist `宇多田ヒカル` accepts `Different Singer` as its candidate artist.

**Impact:** Entire categories of otherwise available music are reported missing, while some tracks with non-Latin artist names can download the wrong artist's recording. Both providers use this scorer.

**Fix:** Preserve Unicode letters/numbers and provide an exact normalized-title fallback when useful tokens are empty. Keep a nonempty original artist credit subject to verification even when tokenization cannot represent it. Exercise the generated scorer as well as its module wrappers.

### 4. Profile restart recovery loses playlists and changes the audio destination

**Locations:** [controller.mjs:176](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/src/engine/controller.mjs:176>), [renderer-integration.mjs:252](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/src/engine/renderer-integration.mjs:252>), [renderer-integration.mjs:364](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/src/engine/renderer-integration.mjs:364>).

Profile records download to `<profile>/Tracks`. `getItems()` creates display rows whose `item.folderName` is the playlist directory, typically `<profile>/Playlists`. Persistence serializes these display items rather than the canonical profile/tracks/playlists model. On restart, `restore()` calls `controller.add()` instead of rebuilding profiles with `addProfile()`.

**Evidence:** Two playlists sharing one queued track produce two saved display entries, both targeting `Fixture/Playlists`. Restore collapses them to one ordinary item, with zero profiles and zero playlists registered, and keeps that incorrect destination.

**Impact:** Restarting a profile run loses shared playlist membership and library/M3U synchronization. Fresh attempts and failed-resume fallbacks can save audio in `Playlists/` instead of `Tracks/`.

**Fix:** Persist the canonical profile, playlist membership, and unique track records, including the original transfer folder. Restore that structure before resubmitting or adopting transfers. Preserve completed memberships needed to maintain the library, rather than treating profile state as outstanding display rows only.

### 5. The Windows package omits the profile-library modules its main process imports

**Locations:** [package.json:44](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/package.json:44>), [main.js:1251](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/main.js:1251>).

The package file allowlist includes `main.js`, `dist/`, assets, and `package.json`, but omits `src/engine/library.mjs` and `src/engine/m3u8.mjs`. `getLibraryEngine()` dynamically imports both from the main process. Renderer bundling does not supply these main-process import targets.

**Evidence:** The existing Windows `app.asar` contains the current main-process imports and neither module. The integration smoke test imports engine sources from the development workspace, so it does not catch this packaged-only failure.

**Impact:** Installed builds catch module-not-found errors when loading/saving profile libraries and cannot generate the promised `library.json` and `.m3u8` files. The rejected import promise is cached, so subsequent calls continue to fail.

**Fix:** Ship the two modules at their required paths or bundle the main-process dependency graph. Verify a profile-library round trip and playlist generation from the actual packaged archive, without access to workspace source files.

### 6. One unavailable recording suppresses its provider for unrelated tracks

**Locations:** [controller.mjs:23](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/src/engine/controller.mjs:23>), [controller.mjs:956](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/src/engine/controller.mjs:956>), [cascade-monochrome.mjs:189](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/src/engine/cascade-monochrome.mjs:189>).

`provider-failed` is in the global source-unavailability set. The Monochrome cascade emits that outcome when all pressings of one particular track have no stream; that does not establish that the service is unavailable for other songs. Nevertheless, the controller marks the entire provider unhealthy for two minutes.

**Evidence:** With one worker and Monochrome selected, the first track returns `provider-failed` and the next track, whose worker would return success, becomes skipped without the worker ever being called. Its attempt history is empty.

**Impact:** One missing recording can cause the rest of a rapidly drained playlist to be skipped. With Keep trying disabled, they remain missing until manual retry; with it enabled, one persistently unavailable first track can repeatedly suppress otherwise downloadable tracks.

**Fix:** Separate track-specific stream exhaustion from service-wide outages. Retain per-track source advancement for the former and use a distinct outcome or stronger evidence to trip global health suppression.

### 7. Filename collision handling saves the right file but points playlists at another file

**Locations:** [main.js:2048](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/main.js:2048>), [controller.mjs:837](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/src/engine/controller.mjs:837>), [renderer-integration.mjs:162](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/src/engine/renderer-integration.mjs:162>).

`freeSavePath()` correctly selects `song (1).flac` when `song.flac` is already occupied. Completion still sends `file: item.getFilename()`, which is the original server filename. The controller copies this value into the profile track record, and library synchronization constructs `Tracks/song.flac` from it rather than using the actual save path.

**Evidence:** The real download-finalization handler reports `savePath: .../song (1).flac` alongside `file: song.flac`. The global manifest uses the uniquified name correctly, but the profile library consumes the conflicting renderer value.

**Impact:** A profile playlist can play the first track's file for both recordings. Server filenames containing characters that are sanitized on save have the same mismatch.

**Fix:** Report the actual saved basename, and derive profile-relative file references from the actual saved path. Verify playlist contents and their resolved files after concurrent filename collisions, not only that the transfers received distinct paths.

## P2 findings

### 8. Reimporting a profile trusts deleted or damaged files as downloaded

**Location:** [AddView.jsx:531](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/src/ui/views/AddView.jsx:531>).

The existing-library merge marks tracks downloaded whenever `library.json` says so and contains a filename. It never checks whether the file still exists or remains valid. `addProfile()` then honors this status and schedules no download. This bypasses the ordinary manifest path's on-disk validation.

**Trigger/evidence:** A downloaded library entry points to `Tracks/deleted.flac`; the file does not exist. The profile controller still reports completed and queues zero downloads.

**Impact:** Re-downloading the whole profile cannot repair tracks deleted or corrupted outside the app.

**Fix:** Validate saved profile-relative paths and content before adopting downloaded status. Missing or invalid files should enter the normal queue.

### 9. Sharing a track across profiles omits it from the second profile's library

**Locations:** [controller.mjs:399](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/src/engine/controller.mjs:399>), [renderer-integration.mjs:157](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/src/engine/renderer-integration.mjs:157>).

Tracks are deduplicated globally by identity, retaining the first profile's `item.profileId`. Library synchronization selects tracks only when that retained ID equals the profile currently being written. A second profile's playlist can reference the key without receiving any track metadata or valid relative path for it.

**Evidence:** Adding two profiles that share one downloaded track writes the second library with one playlist track key and an empty `tracks` object. `formatM3U8()` consequently omits that entry.

**Impact:** The Downloads view says reused/completed while the second profile's exported playlist is empty or incomplete.

**Fix:** Derive profile membership from playlist references and map the actual file into that profile's library layout, copying/linking or resolving an explicitly supported shared path. A single owning `profileId` cannot represent multiple memberships.

### 10. Artwork repair removes the artwork required for successful acceptance

**Locations:** [main.js:1975](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/main.js:1975>), [main.js:2301](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/main.js:2301>).

Finalization first requires embedded PICTURE metadata. It then calls `stripOversizedArtwork()`, which removes all PICTURE blocks larger than 3 MiB. If the only artwork block is oversized, the app accepts the download and subsequently removes its only embedded artwork without checking the final file again. Profile track items also lack the `groupArtwork` used by the worker's separate cover-download path, so a sidecar is not guaranteed there.

**Evidence:** The audit fixture passes `hasEmbeddedArtwork()` before repair and fails it after the real repair function runs.

**Impact:** A completed download violates the app's own embedded-artwork acceptance policy. A profile can lose its only cover copy.

**Fix:** Preserve or replace the embedded image with a smaller valid PICTURE block, and validate the final result. If sidecar-only artwork is intentionally sufficient, make the acceptance policy and UI consistent and guarantee that sidecar before removing the embedded image.

### 11. Equally named playlists overwrite each other's M3U output

**Locations:** [AddView.jsx:485](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/src/ui/views/AddView.jsx:485>), [main.js:1287](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/main.js:1287>).

Playlist output names depend only on their sanitized display names, although separate playlist IDs may have equal names. Different names can also sanitize to the same value. The writer regenerates both into the same target file.

**Evidence:** Two distinct playlist IDs named `Mix`, with different track keys, are written through the actual sync handler. Only the second track list remains in `Playlists/Mix.m3u8`.

**Impact:** One imported playlist silently replaces another on disk, while the library lists both.

**Fix:** Assign and persist a unique output filename using the playlist's stable identity or a collision-safe suffix. Compare names using Windows filename semantics.

### 12. Profile download rows freeze between structural updates

**Locations:** [controller.mjs:189](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/src/engine/controller.mjs:189>), [TrackRow.jsx:151](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/src/ui/components/TrackRow.jsx:151>).

`getItems()` creates new profile-row objects with copied progress/byte primitives. `useRowProgress()` subscribes to updates but compares those same copied values, rather than resolving the live track record. Loose rows work because they are the mutable canonical records.

**Evidence:** A profile row captured at 10% remains at 10% after the canonical track reaches 80%. A subsequent `getItems()` returns 80%, but byte-only events do not cause the parent to fetch it. The dock can continue updating because it explicitly reads the progress channel and reconstructs its rows.

**Impact:** Profile downloads appear stuck even while bytes are moving; their row percentages jump only when some structural change rerenders the parent.

**Fix:** Resolve the canonical track by ID/key inside the progress subscription, or provide a row snapshot selector that reads current canonical values on every relevant progress event.

### 13. Advertised track and Lucida links are rejected by the paste-link flow

**Locations:** [sources.mjs:154](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/src/engine/sources.mjs:154>), [AddView.jsx:713](<C:/Users/Nihil/Desktop/Github Repos/LucidaFetcher/src/ui/views/AddView.jsx:713>).

The interface advertises playlist, album, and track links, and its placeholder explicitly includes Lucida. The parser recognizes Spotify/Deezer playlists and albums only. It has no track-link or Lucida resolver.

**Evidence:** Spotify `/track/...`, Deezer `/track/...`, and Lucida links all return `That link is not a Spotify or Deezer link.` without reaching a metadata transport.

**Impact:** A common way to request one download fails even when the user follows the interface's instructions.

**Fix:** Implement the supported single-track metadata flows and an explicit Lucida path, or narrow the advertised input contract. Use parsed URLs with validated hosts and supported path shapes.

## Suggested repair order

1. Prevent incomplete-file scan hits from bypassing resume; tighten recording and Unicode matching.
2. Preserve canonical profile state across restart and include main-process library modules in the package.
3. Fix per-track versus global provider health and propagate actual saved file paths.
4. Repair profile on-disk validation, shared membership, artwork handling, and playlist naming.
5. Correct row progress subscriptions and pasted-link support.

Follow fixes with regressions covering the combined paths: interrupt/restart a multi-playlist profile, collide filenames and inspect resolved M3U targets, and load/save a library from the actual packaged app. The present passing suite largely exercises these mechanisms independently, which is why it misses their conflicting assumptions.

## Final fix verification

- Full suite: **229 tests passed**, zero failures. Eleven new regression tests exercise matching, Lucida alternates, provider isolation, live profile progress, canonical restart/resume, legacy migration, shared membership, validated library output, path collisions, partial-file checks and track-link imports.
- `npm run lint`: passed without errors or warnings.
- `npm run test:electron`: passed with the production UI, real webviews/cascades, automatic retry, three real Chromium FLAC transfers, collision-safe completion filenames, live pause/resume, shared profile copies, unique playlist files and resolved M3U paths.
- Artwork fixture: a real PNG larger than 3 MiB was embedded in FLAC and downloaded through Chromium. Repair retained the PICTURE block below the size limit, preserved every audio-frame byte and reported the actual saved byte count. The same fixture used a legal unknown total sample count; validation accepts it as allowed by [FLAC Streaminfo, RFC 9639 section 8.2](https://www.rfc-editor.org/rfc/rfc9639.html#section-8.2).
- `npm run dist:win`: succeeded and rebuilt `release/LucidaFetcher-1.0.0-Setup.exe` and `release/win-unpacked`.
- `npm run test:packaged`: passed the same Electron integration against a copy of the rebuilt `app.asar`, with packaged data paths and an isolated user-data directory. Its main process dynamically loaded the library modules from the archive and generated validated libraries and playlists for both profiles.
- Archive comparison: `main.js`, all four runtime engine modules and every production UI asset match the current source/build byte for byte.
- `node review/download-audit-repros.mjs`: now passes all 11 audit regressions.

All 13 reviewed findings are addressed. Real remote provider availability, markup and catalog coverage remain unverified; the integration checks use controlled local provider fixtures. Existing files already stripped of artwork by an older build are not automatically reconstructed.
