# Correctness — LucidaFetcher

Reviewed 2026-09-21. Ranked by severity.

---

### [High] The concurrency slider can put two download chains on one webview

**Where:** `src/engine/pool.mjs:36-46` (`setConcurrency`), reached from `src/ui/views/SettingsView.jsx:131-138`
**Trigger:** With downloads running, drag "Simultaneous downloads" down and back up — a single mouse gesture. React's `onChange` on `<input type="range">` fires on every step, so 3 → 1 → 3 executes `setConcurrency` at each value.

**Detail:** Shrinking drops free slots by filtering (`_freeSlots.filter(s => s < next)`), but busy slots are not in `_freeSlots` at all — they are held by running tasks. Growing then pushes every index in `[_concurrency, next)` back unconditionally, including indices that are still occupied:

```js
if (next > this._concurrency) {
  for (let i = this._concurrency; i < next; i++) this._freeSlots.push(i);
}
```

Reproduced directly against `pool.mjs`:

```
running on slots: [["a",0],["b",1],["c",2]]
freeSlots before: []
freeSlots after 3->1->3: [1,2]
now running: [["a",0],["b",1],["c",2],["d",1],["e",2]]
SLOT COLLISION on slots [1,2]
```

A slot maps 1:1 to a worker `<webview>`. Two chains on one slot means two tracks driving the same page — and, worse, both calling `setDownloadContext` with the *same* `webContentsId`. `main.js:1213` stores that in `pendingContexts` keyed by id, so the second write overwrites the first. `takeDownloadContext` then hands one context to both downloads.

It compounds: when the original tasks finish, `Pool._start`'s `finally` pushes slots 1 and 2 again, so `_freeSlots` accumulates duplicates with every wiggle of the slider.

**Impact:** Files saved to the wrong playlist folder, recorded in `state/manifest.json` and the folder report against the wrong track, and interleaved scrapes on a shared page. This is silent corruption — the download "succeeds".

**Fix:** Derive free slots from what is actually running rather than from arithmetic:
```js
const busy = new Set([...this.active.values()].map((a) => a.slot));
this._freeSlots = Array.from({ length: next }, (_, i) => i).filter((s) => !busy.has(s));
```
Separately, commit the slider on `onMouseUp`/`onBlur` rather than per step (see `04-ux.md`).

**Confidence:** Verified (executed repro)

---

### [High] Debounced state writes are not awaited on quit

**Where:** `main.js:1866-1897`
**Trigger:** Quit from the tray menu ("Quit LucidaFetcher"), or any `app.quit()`, with a queue mutation inside the last 400ms–800ms.

**Detail:** `saveQueue` (400ms), `saveManifest` (500ms), `saveTransfers` (800ms) and `flushReports` (500ms) are all debounced, and `writeJson` is itself async. The only place that flushes them is `window-all-closed`:

```js
app.on('window-all-closed', async () => {
  ...
  await Promise.resolve(saveTransfers.flush());
  await Promise.resolve(saveManifest.flush());
  ...
});
```

Electron does not await listener return values. The handler is `async`, so it returns a pending promise at the first `await` and the quit sequence proceeds to `will-quit` and process teardown while the `fs.promises.writeFile` calls are still outstanding. `before-quit` (`main.js:1866`) sets `quitting` and destroys the tray but flushes nothing.

The comment on `debounced` at `main.js:306-309` states the intent exactly — "a pending write still has to land before the app quits (flush)" — but nothing holds the process open long enough for it to.

**Impact:** Loss of the very files the debounce exists to protect: the resume records for in-flight transfers (so a quit mid-download costs the whole file, which is the documented reason `transfers.json` exists), the manifest entry for a just-finished track (so it re-downloads next launch), and recent queue mutations.

**Fix:** Hold the quit until the writes land:
```js
let flushed = false;
app.on('before-quit', async (e) => {
  if (flushed) return;
  e.preventDefault();
  quitting = true;
  await Promise.all([saveTransfers.flush(), saveManifest.flush(), saveQueue.flush(), flushReports()]);
  flushed = true;
  app.quit();
});
```

**Confidence:** Verified (by reading the quit sequence; not reproduced at runtime)

---

### [High] The artist gate silently switches itself off for short artist names

**Where:** `src/engine/matching.mjs:103-108`
**Trigger:** Any track whose artist name tokenises to nothing — every token under 3 characters or in `STOP`.

**Detail:**
```js
const names = (expected.artist || '').split(/[,&]/).map((n) => T(n)).filter((n) => n.length);
let a = names.length === 0 ? 1 : 0;
```
`T` is `toks`, which drops tokens shorter than 3 characters (`matching.mjs:60`). So "MØ" → `[]`, "AC/DC" → `["ac","dc"]` → both dropped → `[]`, "The xx" → "the" is a stopword and "xx" is too short → `[]`. `names.length === 0` then sets `a = 1`, which is exactly what `isAcceptableWith` requires. The empty-artist fallback — correct for a track with no credited artist — is reached by tracks that have a perfectly good artist the tokeniser cannot represent.

Reproduced:
```
expected artist "MØ"      | candidate by "Some Other Band"  -> a=1 t=1 ACCEPTED=true
expected artist "AC/DC"   | candidate by "Random Coverband" -> a=1 t=1 ACCEPTED=true
expected artist "The xx"  | candidate by "Massive Attack"   -> a=1 t=1 ACCEPTED=true
expected artist "Obzkure" | candidate by "Selena Gomez"     -> a=0 t=1 ACCEPTED=false   (control)
```

**Impact:** For these artists the only thing standing between the user and a wrong file is the title score. The comment above this code names the exact failure it was written to stop ("'Billy Joel' used to satisfy a search for 'Joel Nielsen'"), and it is reopened for a whole class of artist. This affects every cascade — Lucida, Monochrome — and the injected in-page scorer, since it is generated from this function. A wrong file is the worst outcome in this app: it is not noticed until playback.

**Fix:** Distinguish "no artist given" from "artist given but unrepresentable". Keep a raw-token fallback when `names` comes back empty but `expected.artist` is non-blank — e.g. fall back to `normWith(expected.artist, FOLD)` substring containment against the candidate artist, or lower the token floor when that is the only signal available. Whatever the rule, `a` must not default to 1 when an artist was supplied. Note the fix has to keep `scoreWith` free of module-scope references (`test/injectable.test.mjs`).

**Confidence:** Verified (executed repro)

---

### [Medium] No single-instance lock

**Where:** `main.js:1830-1860` (`app.whenReady`)
**Trigger:** Launching the app twice — trivially easy given the NSIS installer creates a desktop shortcut and the app hides to the tray, so the window not being visible is the normal state.

**Detail:** `app.requestSingleInstanceLock()` is never called. Two instances both run `loadState()`, both hold `manifest`/`transfers`/`config` in memory, and both write `state/*.json` wholesale via temp+rename. Last writer wins, and neither knows about the other's downloads. Both also create a tray icon and both register `will-download` on their own `defaultSession`.

**Impact:** Manifest and queue loss (instance A's completed downloads erased by instance B's stale snapshot), duplicate downloads of the same tracks, and two tray icons.

**Fix:** Standard second-instance guard in `whenReady`, with `second-instance` calling `showWindow()`.

**Confidence:** Verified (absence confirmed by grep)

---

### [Medium] A null `webContentsId` silently routes a download through a shared global

**Where:** `main.js:1213-1217` and `src/engine/electron-bridge.mjs:14-18`
**Trigger:** `viewAdapter.webContentsId` returns `null` when `getWebContentsId()` throws — which it does before the webview is attached.

**Detail:** The getter swallows the error and returns `null`. `Worker._runScraped` (`worker.mjs:186`) passes that straight into `setDownloadContext`, and main's handler falls back to a single module-level variable:
```js
ipcMain.on('set-next-download-folder', (event, context) => {
  const id = context && context.webContentsId;
  if (id) pendingContexts.set(id, context);
  else fallbackContext = context;     // one global, shared by every worker
});
```
With 3–6 workers, two of them landing here overwrite each other's context, and `takeDownloadContext` then hands the survivor's folder/title/key to whichever download fires first.

The comment at `main.js:1202-1207` explains at length why keying by worker is essential and calls the alternative "silent corruption, not a visible failure" — the fallback path reintroduces precisely that.

**Impact:** Same class as finding #1: file in the wrong folder, manifest and folder report attributing it to the wrong track.

**Fix:** Refuse a worker context with no id rather than degrading — log it and let the attempt fail loudly. Reserve `fallbackContext` for the genuinely context-free case it was added for (a direct link opened in the main window), e.g. by having callers set an explicit `scope: 'main'` flag.

**Confidence:** Probable (the null path is real; I did not observe it firing at runtime)

---

### [Medium] Chromium downloads get no path containment check and can collide on filename

**Where:** `main.js:1428-1447`
**Trigger:** Two concurrent downloads whose server-suggested filename is identical, in the same folder.

**Detail:** Two distinct gaps.

*Containment.* `savePath = path.join(downloadPath, fileName)` where `fileName` is `item.getFilename()` — a value derived from the remote server's `Content-Disposition`. `yt-download` performs a containment check on its target (`main.js:764-766`) and this path performs none. Chromium does sanitise suggested filenames, so I could not establish an escape; the inconsistency is the finding.

*Collision.* `item.setSavePath(savePath)` is explicit, which bypasses Chromium's automatic " (1)" uniquification. Two live items resolving to the same path both write there. Worse, the `done` handler's cleanup is keyed on the path, not the item:
```js
if (savePath && partialSize(savePath) > 0 && partialSize(savePath) < item.getTotalBytes()) {
  try { fs.unlinkSync(savePath); } catch (e) { /* best effort */ }
}
```
If item A's transfer is interrupted and item B has already written a smaller-but-complete file at the same path, A's cleanup deletes B's finished file.

The realistic route in is a profile download where the same track appears in two playlists: distinct `key`s (the key includes `folderName`, `AddView.jsx:54`), distinct items, same title, both in flight under `maxTransfers: 6`. Note the folder differs in that case, which saves the collision — the exposure is same-folder duplicates whose titles differ but whose *server* filenames do not.

**Impact:** Overwritten or deleted completed downloads.

**Fix:** Check containment against `path.resolve(downloadPath)` as `yt-download` does, and uniquify explicitly before `setSavePath` when the target exists and belongs to a different item. Scope the interrupted-partial cleanup to paths this item actually created.

**Confidence:** Probable (containment: needs check — Chromium's own sanitisation may cover it; collision: verified by reading `setSavePath` semantics)

---

### [Medium] `yt-download` picks an arbitrary file from the output directory

**Where:** `main.js:876-882`
**Trigger:** Any yt-dlp download where the output directory contains more than one file matching `<base>.<audio-ext>`.

**Detail:** yt-dlp's container is not known up front, so the code globs for it afterwards:
```js
const produced = (await fs.promises.readdir(dir))
  .filter((f) => f.startsWith(base + '.') && /\.(mp3|m4a|opus|ogg|flac|wav|aac|webm)$/i.test(f))
  .map((f) => path.join(dir, f));
target = produced[0];
```
`readdir` order is filesystem order, not recency. Leftovers from a previous failed attempt at the same track match too — including yt-dlp's format-specific intermediates such as `Artist - Title.f140.m4a`, which satisfy both the prefix and the extension test.

**Impact:** The manifest and the folder report record a stale or intermediate file, and `bytes` is measured from it. The user's library gets a fragment where a finished track was reported.

**Fix:** Stat the candidates and take the most recently modified, or exclude yt-dlp's `.fNNN.` intermediates; better, read the actual path from `--print after_move:filepath`.

**Confidence:** Probable

---

### [Medium] `DownloadTracker` stitches completions by filename, which is not unique

**Where:** `src/engine/electron-bridge.mjs:78-130`
**Trigger:** Two items downloading files with the same name at the same time.

**Detail:** `byFile.set(file, itemId)` on `download-started`, and `download-status`/`download-progress` look the item up by `file`. A second item with the same filename overwrites the mapping. The first item's completion is then delivered to the second, and the first waits out `startTimeoutMs` (120s) before resolving `null` — reported as `no-download-started` for a track whose file actually landed.

The class-wide fix is the same as the previous finding: main already carries `itemId` on `download-started`, so it can carry it on `download-progress` and `download-status` too and remove the filename stitching entirely. The comment at `electron-bridge.mjs:52-56` notes the mapping was implicit when only one download ran at a time; it is now load-bearing and not unique.

**Impact:** A downloaded track reported as missing; 120s of a slot or a transfer budget wasted.

**Fix:** Send `itemId` on all three channels and key the tracker on it.

**Confidence:** Probable

---

### [Medium] Several network calls have no timeout, so an import can hang forever

**Where:** `main.js:589` (`http-json`), `main.js:658` (`jamendo-search`), `youtube-dl.js:120` (`fetchMetadata`), `youtube-dl.js:268` (`resolveMediaUrl`), `youtube-dl.js:63` (`downloadYoutubeLink`)
**Trigger:** A server that accepts the connection and never responds.

**Detail:** `downloadArtwork` gets this right — `net.fetch(url, { signal: AbortSignal.timeout(15000) })` at `main.js:1409` — and nothing else does. `searchMediaOnce` passes `socketTimeout: 20` to yt-dlp; `resolveMediaUrl`, `fetchMetadata` and `downloadYoutubeLink` do not.

An IPC `invoke` that never settles leaves the renderer's promise pending forever. In the import flow (`sources.mjs` → `media-resolve`) that is a spinner with no timeout and no cancel, and the user's only recourse is to restart the app.

**Impact:** Permanently stuck imports and silently wedged chain attempts.

**Fix:** Pass `AbortSignal.timeout(...)` to every `net.fetch`, and `socketTimeout` plus a wall-clock kill to every yt-dlp invocation.

**Confidence:** Verified

---

### [Medium] `diagnostics-collect` can hang on a broken log stream

**Where:** `main.js:1125-1128`
**Trigger:** `logStream` has errored (disk full, file removed) and has buffered data.

**Detail:**
```js
await new Promise((resolve) => {
  if (!logStream || !logStream.write('')) logStream ? logStream.once('drain', resolve) : resolve();
  else resolve();
});
```
The branch logic is correct, but when `write('')` returns `false` the promise resolves only on `'drain'`. A stream that has emitted `'error'` — handled at `main.js:62` with nothing but a `console.error` — will never drain. There is no timeout and no `'error'`/`'close'` fallback.

**Impact:** "Save diagnostics report" never returns, in exactly the situation a user is most likely to be reaching for it.

**Fix:** `Promise.race` the drain against a short timeout and against `'error'`/`'close'`.

**Confidence:** Verified (by reading; low-probability trigger)

---

### [Low] `stripOversizedArtwork` leaves temp files behind and ignores short reads/writes

**Where:** `main.js:1764-1825`

**Detail:** Three issues in the FLAC rebuild path:
- On any throw after `output` is opened, the `catch` returns `{ error }` and the `finally` closes handles — but `tmp` (`<file>.flac.arttmp`) is never unlinked. Failures leave debris in the user's music folder.
- `await input.read(buf, 0, buf.length, b.at)` at line 1798 ignores `bytesRead`. A short read leaves zero bytes in the metadata block that then gets written.
- `await output.write(buf)` ignores `bytesWritten`.

This function rewrites the user's audio file in place (via rename), so a silently truncated metadata block produces a file that is worse than the one it was repairing.

**Fix:** Unlink `tmp` in the catch; assert `bytesRead`/`bytesWritten` match the expected length and abort the rebuild otherwise.

**Confidence:** Verified

---

### [Low] The album search variant is never built

**Where:** `src/ui/views/AddView.jsx:52` vs `src/engine/variants.mjs:43-46`

**Detail:** `buildSearchVariants(title, artist, album)` constructs `[exact, primary, album]` as its fourth variant, documented as "disambiguate by album". `AddView.toQueueItem` calls `buildSearchVariants(title, artist)` with no third argument and never carries `album` on the queue item at all. With `album` undefined the variant collapses to `"<exact> <primary>"`, which is identical to variant 2 and is removed by the dedup filter on line 49.

`Controller.add` (`controller.mjs:164`) would pass `item.album`, but only when `searchVariants` is empty — and AddView always populates it.

**Impact:** One of six documented search strategies never runs. Minor on its own, but `DEFAULT_MAX_VARIANTS` is 2, so the ordering of the surviving variants is what actually gets used and the list is shorter than it reads.

**Fix:** Carry `album` onto the queue item and pass it through.

**Confidence:** Verified

---

### [Low] `restore()` writes records straight into `items` without registering their identity key

**Where:** `src/engine/renderer-integration.mjs:222-227`

**Detail:** Skipped-in-an-earlier-run tracks are inserted with `controller.items.set(item.id, {...})`, bypassing `add()` and therefore never populating `controller.keys`. `add()`'s duplicate check consults `keys`, so re-adding the same playlist produces a second record for a track already on screen as missing.

**Fix:** Set `controller.keys` alongside, or route through a small `_adopt` helper that maintains both maps.

**Confidence:** Verified

---

### [Low] macOS: closing the window permanently poisons `quitting` and pauses every transfer

**Where:** `main.js:1875-1897`

**Detail:** `window-all-closed` sets `quitting = true` and pauses all live downloads unconditionally, then skips `app.quit()` on darwin. The app stays alive with every transfer paused and nothing to resume them, and `quitting` stays true — so the `done` handler takes its "interrupted by the quit" branch for the rest of the session.

The app is Windows-first (`dist:win`, NSIS only), so this is latent rather than live.

**Fix:** Only pause and flush when actually quitting; on darwin, leave the queue running.

**Confidence:** Verified
