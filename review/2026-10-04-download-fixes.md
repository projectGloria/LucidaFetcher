# Artwork, recording identity and download throughput fixes

Implemented 2026-10-04.

- Loose playlist covers are scheduled when items enter the queue, independently of audio downloads. Profile libraries preserve playlist artwork URLs and save a JPEG beside each M3U8, using the same unique filename stem. Profile avatars use the profile's `cover.jpg`. Artwork fetches have a shared concurrency limit of four, deduplicate destinations, repair empty files, validate image decoding, and save actual JPEG data through a temporary file.
- Lucida release pages select a matching track row before clicking a control, refuse different cuts and ambiguous controls, and avoid album-download text fallbacks. Both provider scorers use duration where available and preserve title word order. Monochrome's current `track-item-duration` field is included.
- Completed FLACs are checked against embedded title/artist tags, duration and ISRC before entering the manifest. A rejected new transfer is removed and the source chain can continue. Existing downloads and imported profile libraries are checked again on reuse; old mismatched files are preserved on disk but are not treated as satisfying the request. Metadata reads skip artwork/audio bodies, are bounded, and cache by file size and modification/change timestamps.
- A worker waiting at the detached-transfer limit can hand its existing transfer off when any detached file finishes. It no longer waits solely for its own slower file while another transfer has already freed capacity. Existing concurrency and transfer settings are preserved, with bounded handoffs and cancellation cleanup.
- Profile imports read up to four playlists concurrently while retaining input order. Existing library checks use batches of eight. Profile output skips identical snapshots and does not rewrite libraries for search/status-only changes. Explicit search-backend outages retire that service temporarily, while track-specific failures remain local to the track.

## Verification

- `npm test`: 242 passing tests, including restoring artwork when all playlist audio already exists.
- `npm run lint`: passes without warnings.
- `npm run test:electron`: passes against the built UI and real Electron webviews/downloads. Includes a server returning a valid FLAC tagged as a remix, rejection and retry to the correct fixture, native JPEG decoding of separate playlist covers, filename collisions, byte integrity, large embedded-picture repair, shared profile copies, playlist paths, pause/resume and clean quit.
- Synthetic profile-read fixture: twelve reads with a 20 ms simulated response delay took 376 ms serially and 95 ms with four workers. This illustrates scheduling overhead removal, not a claim about live download bandwidth.
- Windows build output is in `release/fixed/`, preserving the previous release artifacts. Packaged verification passes using `npm run test:packaged -- --archive release/fixed/win-unpacked/resources/app.asar`.

Live Lucida inspection returned HTTP 403. Real catalog coverage and remote transfer speed remain unverified. Files with omitted identity tags or unknown sample counts can only be checked against the metadata available; metadata cannot establish waveform equivalence.
