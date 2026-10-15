# Performance — LucidaFetcher

Reviewed 2026-09-21.

The engine's pipeline design is sound and the expensive decisions in it are already reasoned about in comments (detached transfers, fetch-ahead depth, flat-playlist resolution, the scrape cache). The findings below are the places where the measured cost does not match the intent.

---

### [Medium] The unhealthy-store skip list is never populated, so a dead store costs a full timeout on every track

**Where:** `src/engine/controller.mjs:296-297`, consumed at `controller.mjs:492`, implemented at `src/engine/chain.mjs:117-126`
**Trigger:** Any store that is down or rate-limiting during a long run.

**Detail:** `markServiceUnhealthy` / `markServiceHealthy` are the only writers of `this.unhealthy`, and nothing in `src/` or the UI calls either:

```
src/engine/controller.mjs:296  markServiceUnhealthy(service) { ... }   <- definition
test/controller.test.mjs:157   c.markServiceUnhealthy('qobuz');        <- only caller
```

So `this.unhealthy` is permanently empty and `nextAttempt(plan, { index, skip: this.unhealthy })` never skips anything. The whole "stores currently known to be down" mechanism — documented in `chain.mjs:110-115` and exercised by tests — does not exist at runtime.

The cost is concrete. Every track pays the full search budget against the dead store before `advanceAfter`'s `service-unavailable` branch moves it on, and that budget is per-track, not per-run: `LUCIDA_EMPTY_POLLS` is 10 polls × 500ms before a rendered-but-empty result list is called empty (`cascade-lucida.mjs:20`), on top of page load, and up to `domReadyTimeoutMs` of 45s when the store does not respond at all. Multiply by a 130-track playlist and by the number of variants per store.

Note `advanceAfter` already does the per-*track* half of this correctly: a `service-unavailable` skips that store's remaining variants for that track. What is missing is carrying the knowledge across tracks.

**Fix:** Call `markServiceUnhealthy(step.service)` from `_walkChain` when an attempt returns `service-unavailable` / `provider-failed`, with a time-based or count-based reset (e.g. clear after N minutes, or after one successful attempt on that service) so a transient blip does not retire a store for the session. The plumbing and the tests are already there.

**Confidence:** Verified

---

### [Medium] `diagnostics-collect` reads the whole session log synchronously and ships every event over IPC

**Where:** `main.js:1113-1122` (`readSessionEvents`), `main.js:1130-1148`, consumed at `src/ui/diagnostics.js:101`
**Trigger:** Saving a diagnostics report after a long session; worse with "include previous sessions" ticked.

**Detail:** Three compounding costs on the main process and one on the renderer:

```js
try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
for (const line of text.split('\n')) { ... JSON.parse(line) ... }
```

- `fs.readFileSync` blocks the main process — the same event loop servicing IPC, `will-download` and every worker webview — for the whole file.
- `text.split('\n')` materialises a second copy as an array of strings, then `JSON.parse` per line materialises a third as objects.
- `opts.includePrevious` concatenates up to 3 more whole sessions on top.
- The entire `events` array is then returned over IPC, which structured-clones every object across the process boundary, and `summarize()` walks it again in the renderer.

The file's own header comment sizes the problem: "an hour of use is tens of thousands of lines". The app logs every attempt outcome, every console message from every scraped page, and sampled progress for every download, and is designed to run for hours on a profile download.

**Impact:** A multi-second main-process freeze — dropped frames, stalled IPC, paused-looking downloads — triggered by the button a user presses when something is already wrong.

**Fix:** Stream the file (`readline` over a read stream) and summarise incrementally in the main process, returning the rendered summary plus the 1500-line raw tail rather than every event. `summarize` is pure and dependency-free, so moving it main-side costs nothing architecturally — the comment at `main.js:1097-1101` explains it lives renderer-side because `src/engine` is bundled into the UI, which is a packaging constraint worth re-checking rather than a hard one.

**Confidence:** Verified

---

### [Medium] Startup stats every manifest entry synchronously

**Where:** `main.js:456-467` (`loadState`), called from `app.whenReady`
**Trigger:** Every launch, proportional to library size.

**Detail:**
```js
for (const key of Object.keys(manifest)) {
  const rec = manifest[key];
  if (rec && rec.savePath && !fs.existsSync(rec.savePath)) { delete manifest[key]; pruned++; }
}
```
One synchronous `existsSync` per manifest entry, before the window is created. The manifest accumulates one entry per completed download forever, so this grows with everything the user has ever fetched. On a cold filesystem cache or a network/external drive, thousands of sync stats is a visible delay before anything appears on screen.

There is a second-order effect worth flagging: this prunes entries whose files are merely *unreachable*, not deleted. If the download folder is an external or network drive that is not mounted at launch, the entire manifest is wiped and every track re-downloads.

**Impact:** Slow cold start that scales with library size; total manifest loss if the download volume is offline at launch.

**Fix:** Do the prune lazily (`checkDownloaded` already prunes one entry at a time on the read path) or asynchronously after the window shows. Skip pruning entirely when the download root itself is not present.

**Confidence:** Verified

---

### [Low] Per-process caches with no eviction

**Where:** `main.js:964` (`reportCache`), `src/engine/electron-bridge.mjs:68` (`early`), `:60` (`byFile`), `:70` (`started`)

**Detail:** Four maps that only shrink on the happy path:
- `reportCache` holds a full parsed folder report per folder, evicted only at `main.js:884` and `main.js:1580`. A 40-playlist profile download holds 40 reports for the session.
- `DownloadTracker.early` holds results that arrived before anyone awaited them; entries are removed only when `await()` eventually asks. An attempt that moved on never collects, and the entry stays for the session.
- `byFile` is deleted only on `download-status`. A download whose completion never reaches the renderer (window destroyed — `toUI` at `main.js:1399` silently drops the send) leaks its entry.
- `started` is cleared only in `_settle`.

**Impact:** Slow growth over a multi-hour run. Not a crash risk at realistic sizes — flagged because this app is explicitly designed for very long sessions.

**Fix:** Timestamp entries and sweep periodically, or bound the maps.

**Confidence:** Verified

---

### [Low] yt-dlp searches are globally serialised with fixed spacing

**Where:** `youtube-dl.js:160-172`

**Detail:** Every search for a given prefix runs through one promise chain with a 750ms gap after success and 2000ms after failure. This is deliberate and well-argued — YouTube throttles hard, and the comment explains that three workers hammering search is what triggers it — but it makes the YouTube/SoundCloud stage a global serialisation point regardless of the concurrency setting.

A playlist where most tracks fall through to the terminal stage pays `(search duration + 750ms) × track count` in sequence, with the pool's other slots idle behind it. With 130 tracks that is several minutes of pure spacing.

**Impact:** The concurrency slider has no effect on the slowest stage of the chain.

**Fix:** None urgent — the throttling constraint is real and the current behaviour is the safe side of the trade. If it becomes a bottleneck, an adaptive gap (back off only after an actual `SEARCH_UNAVAILABLE`, rather than a flat 750ms after every success) would recover most of the throughput.

**Confidence:** Verified (behaviour); impact not measured

---

### [Low] Synchronous filesystem work on the main process in the download path

**Where:** `main.js:1010` (`fs.mkdirSync` + `readJson` in `writeReport`), `main.js:1439-1441` (`existsSync` + `mkdirSync` in `handleWillDownload`), `main.js:930` (`statSync` in the scan backfill)

**Detail:** Individually small, but they sit in `will-download` and in the report writer, both of which run on the main process while transfers are in flight. `writeReport`'s `readJson` is a synchronous whole-file read on a cache miss.

**Fix:** These are all reachable from `async` contexts already; `fs.promises` equivalents are a mechanical change.

**Confidence:** Verified
