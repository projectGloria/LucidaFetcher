# Security — LucidaFetcher

Reviewed 2026-09-21.

Threat model for this app: it is a local, single-user desktop tool with no server and no auth. The meaningful boundaries are (a) content from scraped pages and third-party APIs flowing into the main process, (b) subprocess invocation of yt-dlp, and (c) the diagnostics report, which is explicitly built to be handed to someone else.

---

### [High] The diagnostics report leaks the Jamendo client ID and signed download URLs

**Where:** `src/engine/diagnostics.mjs:186-194` (`redactConfig`) vs `main.js:1155` (`raw`), `main.js:496` (`settings.change`), `main.js:1477` (`download.start`)
**Trigger:** Enter a Jamendo client ID in Settings, then use Settings → save a diagnostics report and send it to anyone.

**Detail:** `redactConfig` correctly masks credential-shaped config keys, and `/clientid/i` does match `jamendoClientId`, so the **Settings block** of the report is clean. The raw event tail is not:

```js
raw: events.slice(-RAW_TAIL).map((e) => JSON.stringify(e)),   // main.js:1155
```

`renderReport` appends those 1500 raw JSON lines verbatim. Two logged events carry secrets into them:

- `main.js:496` — `ipcMain.on('set-config', ...)` does `logEvent('settings.change', patch || {})`. Typing the client ID writes `{"evt":"settings.change","jamendoClientId":"<the actual id>"}` to the session log. `SettingsView.jsx:110-111` patches on every keystroke, so the log holds every prefix of it too.
- `main.js:1477` — `logEvent('download.start', { ..., url: item.getURL() })` records the full resolved download URL from Lucida/Qobuz/Tidal, which for these brokers is a signed, time-limited URL.

So the report's own redaction is bypassed by the evidence section sitting underneath it. The user is told the file is safe to hand over by the fact that redaction visibly happened.

**Impact:** Credential disclosure to whoever receives a diagnostics report. Also `downloadPath` and `stateDir` are printed in cleartext (`diagnostics.mjs:240-241`), which discloses the Windows username — that one looks deliberate and is defensible.

**Fix:** Redact at the point of logging, not at the point of rendering — `set-config` should log key names and value *lengths*, never values. Then run the raw tail through a scrubber before it reaches the report (strip query strings from URLs, drop any field whose key matches the `redactConfig` pattern). Redacting only the pretty-printed copy while shipping the raw one is the worst of both.

**Confidence:** Verified (traced `set-config` → `logEvent` → `recentEvents`/log file → `diagnostics-collect.raw` → `renderReport`)

---

### [Medium] TLS certificate verification is disabled for every yt-dlp call

**Where:** `youtube-dl.js:73`, `:123`, `:187`, `:277` — `noCheckCertificates: true`

**Detail:** Every yt-dlp invocation in the app — download, search, metadata, playlist resolve — passes `--no-check-certificates`. There is no comment justifying it, unlike essentially every other non-obvious decision in this codebase, which suggests it was copied forward rather than chosen.

**Impact:** Anyone in a position to MITM the connection (hostile Wi-Fi, a compromised router, an intercepting proxy) can serve arbitrary content in place of the expected audio, and it gets written into the user's music folder and recorded in the manifest as a legitimate download from SoundCloud/YouTube/Jamendo. It also silently defeats the Jamendo host check at `main.js:753-755`, which validates the URL but not who answers it.

**Fix:** Remove the flag from all four call sites. If some specific host genuinely needs it, scope it to that host and say why in a comment.

**Confidence:** Verified

---

### [Medium] `downloadArtwork` fetches an unvalidated URL and writes the response unbounded

**Where:** `main.js:1406-1419`, called from `main.js:1447`

**Detail:**
```js
async function downloadArtwork(url, artPath) {
  const res = await net.fetch(url, { signal: AbortSignal.timeout(15000) });
  ...
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.promises.writeFile(artPath, buf);
}
```
`url` is `ctx.artworkUrl`, which originates as `item.groupArtwork` — a value taken from scraped Spotify/Deezer/SoundCloud responses and carried through the renderer. Unlike `http-json` (`main.js:579-598`) and `media-resolve` (`main.js:697-706`), which both enforce host allowlists, this path applies:

- no protocol check
- no host allowlist
- no response size cap (`arrayBuffer()` buffers the whole body in the main process)
- no content-type check (whatever comes back is written as `cover.jpg`)

**Impact:** A poisoned artwork URL in a playlist response turns into an outbound request from the user's machine to an attacker-chosen host — including intranet addresses the user's browser could reach — with the response written to disk. The unbounded buffer is a straightforward memory-exhaustion lever on the main process.

**Fix:** Require `https:`, cap the body (`Content-Length` check plus a streaming cap), verify `Content-Type` starts with `image/`, and reuse the allowlist style already applied to `http-json`.

**Confidence:** Verified

---

### [Medium] The `http-json` allowlist only guards the first request in a redirect chain

**Where:** `main.js:579-598`

**Detail:** The allowlist check is thorough — exact hostname match via `hasOwnProperty`, `https:` only, per-host path predicate — and then:
```js
const res = await net.fetch(u.href);
```
`net.fetch` defaults to `redirect: 'follow'`. The allowlist is never re-applied to the redirect target, so an allowed host that redirects (or is made to redirect via an open-redirect on `api.deezer.com` / `soundcloud.com/oembed`) reaches any destination. The `soundcloud.com/oembed` path is the more interesting one because its `url` query parameter is attacker-influenceable — it carries whatever the user pasted.

The comment at `main.js:568-570` states the design intent plainly: "The host allowlist is the whole security story: the renderer must never be able to turn this into a general purpose proxy." Redirect following is the hole in that story.

**Impact:** SSRF from the main process to arbitrary hosts, with the JSON body returned to the renderer.

**Fix:** `net.fetch(u.href, { redirect: 'manual' })` and re-validate each hop against `JSON_HOSTS`, or `redirect: 'error'` if these endpoints never legitimately redirect. Add a body size cap while there — `await res.text()` is currently unbounded.

**Confidence:** Verified (allowlist bypass via redirect confirmed by reading; I did not find a live open redirect on either host)

---

### [Low] `yt-metadata` is a dead IPC handler that hands an arbitrary URL to yt-dlp

**Where:** `main.js:611-613`

**Detail:**
```js
ipcMain.handle('yt-metadata', async (event, url) => {
  return await yt.fetchMetadata(url);
});
```
No URL parse, no protocol check, no host allowlist — compare `media-resolve` directly below it, which does all three. The only caller is the legacy `renderer.js:443`, which `main.js` no longer loads; the React UI never invokes it.

**Impact:** Currently none — nothing calls it. It is a live, unguarded subprocess entry point kept alive by an unused handler, and yt-dlp's generic extractor accepts a very wide range of inputs.

**Fix:** Delete it along with the legacy renderer (see `05-architecture.md`), or give it the same `MEDIA_HOSTS` check `media-resolve` uses.

**Confidence:** Verified

---

### [Low] Electron hardening: no navigation, window-open, webview or CSP guards

**Where:** `main.js:1691-1696` (window config); absence confirmed across `main.js` and `src/ui/index.html`

**Detail:** The main window runs `nodeIntegration: true`, `contextIsolation: false`, `webviewTag: true`. That is a deliberate, coherent choice for this app — the renderer needs `require('electron')` and there is no preload — but it removes every safety net, so the surrounding guards matter more than usual. None are present:

- no `setWindowOpenHandler` — nothing denies `window.open` from the main window
- no `will-navigate` handler — nothing pins the main window to its local origin
- no `will-attach-webview` handler — nothing strips `nodeintegration` / `preload` / `allowpopups` off webview tags before they attach
- no CSP `<meta>` in `src/ui/index.html`, and none set via headers

The worker webviews themselves are created without `nodeintegration` (`electron-bridge.mjs:213-222`), so scraped pages do run with Node off and context isolation on — that part is right. But nothing *enforces* it: an attribute added later, or any content that reaches the main window's origin, gets full Node with no isolation.

The main window does render remote images (`<img src={artworkUrl}>`) from scraped data. Images cannot execute script, so I found no path from scraped content into the main window's context.

**Impact:** No exploitable path found today. This is defence-in-depth that is missing where the consequences of ever needing it are total.

**Fix:** Add `will-attach-webview` (delete `preload`, force `nodeIntegration: false`), `setWindowOpenHandler(() => ({ action: 'deny' }))`, a `will-navigate` handler that blocks anything that is not the app's own origin, and a CSP meta that at minimum pins `script-src 'self'`.

**Confidence:** Verified (absence); no exploit path identified

---

## Things that are done right

Worth recording, because they are the non-obvious cases and a future change could undo them:

- **No script injection into the cascades.** `injectableScorer` (`matching.mjs:160-179`) puts the track title and artist through `JSON.stringify` before splicing them into generated source, and the nesting of template literals does not re-evaluate `${}` in interpolated values. A title containing `${...}`, backticks or quotes cannot break out. `test/injectable.test.mjs` covers the related minification hazard.
- **`cacheFile`** (`main.js:534-536`) hashes the cache key with SHA-1 before using it as a filename — no path traversal from a pasted URL.
- **`folderFor`** (`main.js:867-880`) sanitises each path segment separately and then verifies containment against the resolved root rather than trusting the character class. The `yt-download` target check (`main.js:764-766`) does the same.
- **`jamendo-search`** (`main.js:639-690`) validates the client ID shape, requires `audiodownload_allowed`, requires a Creative Commons licence URL, and re-validates that the media URL is HTTPS on a jamendo.com host before the result is ever offered as a candidate.
- **`SERVICE_IDS`** (`main.js:604-607`) is an allowlist rather than a pass-through for a string that gets persisted.
