# Source expansion and performance verification

Implemented public catalog imports, gated direct-provider adapters, staged FLAC
finalization with decodable artwork, bounded metadata caches, virtual queue rows,
batched restoration, and lazy browser-worker retirement. Existing defaults and
source selections are preserved. No new download provider is enabled.

## Same-machine measurements

Measurements collected October 28, 2026 on this Windows development machine.
Times are milliseconds; these are single controlled runs, not statistical claims.

| Fixture | Before | After |
| --- | ---: | ---: |
| 500-track engine restore | 15.09 | 5.16 |
| 5,000-track engine restore | 943.31 | 37.06 |
| 500-track grouped mount | 195.8 | 30.5 |
| 500-track grouped filter | 32.1 | 9.5 |
| 5,000-track grouped mount | 662.3 | 161.4 |
| 5,000-track grouped filter | 178.3 | 13.4 |
| 5,000-track custom mount | 651.5 | 136.2 |
| 5,000-track custom filter | 135.8 | 8.6 |
| 5,000-track grouped mounted rows | 5,000 | 19–20 |
| 5,000-track custom mounted rows | 5,000 | 20–21 |

The engine benchmark compares the HEAD controller/restore implementation with
the current implementation, using shared current dependencies and in-memory IPC.
The UI benchmark compares the HEAD QueueView with the virtualized QueueView,
using the same current engine and row components at 1400 × 900. Mount/filter
measurements cover synchronous render/layout; they are not full app cold-start
or input-to-paint measurements. Both layouts exercise scrolling; custom ordering
uses stable item IDs and the keyboard fixture checks focus retention.

With three simulated workers and a 1 ms fixture delay, 5,000-track first completion
was 8.81 → 3.14 ms and total completion was 25,001 → 24,920 ms. This shows no
meaningful download-throughput improvement. No live playlist completion claim is
made. CPU, process working-set and heap snapshots are recorded in the JSON files;
they are not isolated peak-memory measurements and do not prove a RAM reduction.

Reproduce with `npm run benchmark:engine` and `npm run benchmark:ui`.
Raw results: [engine](engine-performance-2026-10-28.json),
[UI](performance-2026-10-28.json), [screenshot](queue-performance-2026-10-28.png).

## Live qualification, separate from fixtures

Run `npm run qualify:sources`. The October 28 run recorded:

- HiFi Tidal: `api.monochrome.tf` failed DNS (`ENOTFOUND`); disabled.
- Squid Qobuz: `qobuz.squid.wtf` failed DNS; disabled. Its current playback
  response contract is unverified; the adapter is a scaffold behind that gate.
- Tidal track: title including remix, artwork and duration imported successfully.
- Tidal album: six tracks imported, completeness explicitly unconfirmed.
- Tidal playlist: 50 tracks from the tested 100-track playlist; explicitly partial.
- Qobuz album: 13 tracks via public-page fallback; completeness unconfirmed.
- Qobuz playlist: the public Top 50 imported 50 tracks with a confirmed total.
- Qobuz single-track: tested IDs returned HTTP 404. The fixture-backed import
  path exists, but live single-track support has not been established.

These are observations of specific URLs and this machine's network, not claims
that an entire service is globally unavailable. See
[qualification output](provider-qualification-2026-10-28.json).
The [HiFi documentation](https://github.com/arubi9/hifi-api) describes manifests;
[Monochrome's instance documentation](https://github.com/monochrome-music/monochrome/blob/main/INSTANCES.md)
warns that its instance list is outdated. Neither is proof of working downloads.

## Acceptance and remaining limits

Downloads require FLAC structure, recording matching, and decodable embedded
artwork. Separately fetched artwork is embedded without changing encoded audio
bytes. Lossy API manifests, malformed metadata, wrong recordings and missing or
undecodable artwork are rejected. The existing structural FLAC validator is not
a full decoder/CRC audit of every audio frame; upstream transcoding cannot be
determined from the container. Publication uses exclusive hard links and has
been tested on NTFS; other filesystem support remains a limitation.

Tests cover pagination, unavailable imports, cancellation, matching, provider
failure/cooldowns, bounded requests, artwork byte preservation, item subscriptions,
batched restoration, virtual ranges, retries and worker retirement. Source and
packaged Electron fixtures exercise real Chromium transfers, pause/resume,
wrong-recording rejection, separate artwork embedding, oversized-artwork repair,
audio-byte preservation, persisted preferences and shutdown flushing.

Final verification:

- `npm test`: 318 passed, zero failures.
- `npm run lint`: passed without warnings.
- `npm run test:electron`: passed, including catalog parser fixtures.
- `npm run pack`: passed; generated `release/win-unpacked/LucidaFetcher.exe`.
- `npm run test:packaged`: passed against the packaged archive.
- `git diff --check`: passed (only Git's configured line-ending notices).

The unpacked build is a local smoke-tested artifact, not a published installer.
No user state or logs were used by the smoke fixtures.
