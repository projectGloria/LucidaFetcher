# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```
npm start                      # launch the Electron app (electron .)
node --check renderer.js       # the only syntax gate; run after editing
node --check main.js           # same, after touching the main process
ls logs/                       # one .jsonl per run - see Session logging
ls state/                      # config, queue, manifest, cache - see Persistent state
cat <downloadPath>/*/_lucidafetcher.json   # per-folder record of got/missing - see Per-folder download report
```

No test runner, linter, or build step exists (`npm test` is the npm placeholder that exits 1). Not a git repository.

## What this is

An Electron desktop app that automates https://lucida.to (a third-party stream-ripping frontend) to download music. There is no Lucida API — **the entire integration is browser automation against Lucida's live DOM**, so scraping selectors are the fragile core of this codebase.

## Architecture

Three files carry all the logic.

**`main.js` (main process)** — creates a single `BrowserWindow` with `nodeIntegration: true`, `contextIsolation: false`, `webviewTag: true` (deliberate: the renderer uses `require('electron')` directly and drives `<webview>` tags). It owns the download path and hooks `session.defaultSession.on('will-download')` to redirect every download into `downloadPath/<folderName>/`, and side-downloads `cover.jpg` into that folder from the album/playlist artwork URL. It relays `download-started` / `download-progress` / `download-status` back to the renderer, and owns the session log and everything under `state/` (see *Persistent state*). It also repairs finished FLACs (see *Oversized embedded artwork*), enforces the speed limit, and answers "is this track already on disk?".

**`index.html`** — three tabs (Search / Downloads / Settings) plus two `<webview>` elements hidden behind `.hidden-webview` (`z-index:-1; opacity:0.001`). These invisible webviews are the automation surface; the app has no visible browser.

**`renderer.js`** — all app logic. Two distinct webview roles:

- `#scraper-view` — loads a Lucida search or `?url=` page, then on `dom-ready` runs an injected `executeJavaScript` polling script (500ms × 30 attempts, so ~15s before it gives up and resolves an empty list) that scrapes results into `{link, image, texts[], group?}` objects. It handles two page shapes: search-result cards (`.search-result` → `.metadata h1/h2/a`) and album/track listings (`div[id^="track-"]` → `p` for title, `.ico-button[data-url]` for the source URL, rewritten to `origin + '/?url=' + encodeURIComponent(raw)`). It bails early if Lucida renders its `.error h2` "uh-oh!" page.
- `#download-view` — loads one queued item's Lucida page and, on `dom-ready`, injects an escalating cascade to trigger the download: if it landed on `/search`, navigate to the best-scoring result (see *Match verification*), else click `.download-button`, else a download-icon `<button>`, else any element whose text matches download/download track/download album. Retries on a 500ms interval up to 60 attempts, then resolves `'timeout'`.

**Both webviews must reach page content through `webview.executeJavaScript(...)`.** Code written directly in the `dom-ready` listener runs in the *renderer's* context (`file://.../index.html`), where `document` is the app's own UI and `location.href` is the app's own URL — it silently finds nothing rather than erroring. The same trap applies to any dedupe guard: compare `downloadView.getURL()`, never `window.location.href`, which in the renderer is a constant and makes the guard permanently true after the first event.

Both cascades live in **template literals**, so `node --check renderer.js` does not parse them — a broken regex or a missed escape inside one shows up only as a silently failing run. Every backslash has to be doubled in the source: write `\\s` / `\\u0300` so the injected regex actually sees `\s` / `\u0300`, and the only real test is extracting the literal from source and running it in plain Node — see *Testing the injected matcher*.

**Spotify links bypass Lucida for metadata.** `open.spotify.com/...` URLs are rewritten to `open.spotify.com/embed/...` and the `__NEXT_DATA__` `<script>` JSON is regex-extracted for `props.pageProps.state.data.entity.trackList`. Per-track artwork requires a second embed fetch per track (`/embed/track/<id>` → `entity.visualIdentity.image[0].url`). Each Spotify track is then converted into a *Lucida search URL* via `buildSearchQuery()` + `lucidaSearchUrl()`, not a direct link — so Spotify downloads route through the search-result cascade in `#download-view`.

**Query construction (`buildSearchQuery`)** — the query is *not* the raw title plus every credited artist. It drops credit parentheticals only (`(feat. X)`, `[with Y]` — `CREDIT_PAREN`), strips the remaining brackets while **keeping the words inside them**, and appends just the *primary* artist (everything before the first `,` or `&`). Both halves were measured against amazon on 2026-08-28: a version marker (`Remix`) has to survive into the query or the wanted cut is not returned, while passing Spotify's full collaborator list narrows the result set to zero. Change either half and re-measure — the comment above `CREDIT_PAREN` in `renderer.js` records the four query shapes tried and their hit counts.

**Match verification** — on a `/search` page the cascade scores every `.search-result` against the `title`/`artist` carried on the queue item, and navigates only to the best hit that clears both gates:

- **Artist** — one *whole* credited name must appear, every token of it, in the candidate's artist **or** title (the title case covers "Track (Someone Remix)"). Spotify comma-separates several credits and Lucida usually lists one, so any single credit matching in full is enough. Matching on a shared token alone is not: that let "Billy Joel" satisfy a search for "Joel Nielsen".
- **Title** — `MIN_TITLE_SCORE` (0.6) of the expected title's significant tokens, **and** no mismatch on an `ALTERING` marker (`remix`, `slowed`, `instrumental`, `live`, `nightcore`, …). A marker present on one side but not the other zeroes the title score outright, because it means a different recording, not different wording. This is why those words must never join `STOP`: while they did, "No Glory (Remix)" reduced to the token `glory`, the remix / instrumental / slowed+reverb cuts all scored 1.0, and the queue took whichever Lucida ranked first. `version` and `original` stay in `STOP` deliberately — they describe an ordinary release, and gating on them rejects good hits.

Failing either gate resolves `no-match`, and the item moves down the fallback chain. This exists because Lucida always returns *something* — a track absent from the service yields a confident-looking wrong song, and its ranking is nondeterministic between runs. Token comparison normalizes via NFD plus an explicit `FOLD` map, since stroked/ligature letters (`ł`, `ø`, `æ`, `ß`) have no NFD decomposition and would otherwise become spaces and shatter a word. Tune `MIN_TITLE_SCORE` / `STOP` at the top of the injected script, and re-check the change with the harness in *Testing the injected matcher* — nothing else in the repo will catch a broken one.

**Service fallback** — a track that can't be got from its original link is re-searched on each service in `FALLBACK_SERVICES` before being skipped. `tryFallbackOrAbandon()` rewrites `item.url` via `lucidaSearchUrl(item.searchQuery, service)`, resets the per-service attempt budget, and re-queues at the front; `item.fallbackIndex` is `-1` for the original link and an index into the chain thereafter. Before taking that index it **walks past any store already in `item.tried`** — the first attempt uses whatever service the incoming link carried (usually qobuz), so without this an enabled `qobuz` entry would re-search the store that just failed and every skipped track would pay for it.

**The chain is a setting, not a constant.** `ALL_SERVICES` is every slug the picker on lucida.to offers (`qobuz, tidal, soundcloud, deezer, amazon, yandex`); which of them the app actually walks comes from `config.fallbackServices`, chosen in Settings → Fallback Services, and falls back to `DEFAULT_FALLBACK_SERVICES` (`['amazon']`) when unset or unrecognised. This is deliberately not a code constant: Lucida's backends come and go, and routing around a dead one must not need an edit. Two consequences for the queue: `FALLBACK_SERVICES` is a `let`, and `queue.json` outlives a change to it — so a restored `fallbackIndex` can point at a different store or past the end of a shortened chain, which is why items also carry `item.service` (the name the index *meant*) and `serviceOf()` falls back to it.

**What actually answers, re-probed 2026-08-29** with `Get Lucky Daft Punk` — a track in every catalogue — each slug tried with no `country` param and with `country=US`:

| service | result |
|---|---|
| `qobuz` | 60 cards |
| `amazon` | 13 cards |
| `soundcloud`, `tidal`, `deezer`, `yandex` | 0 cards, Lucida's "uh-oh!" page |

So soundcloud is down at Lucida's end, not missing a query parameter, and the same holds for tidal, deezer and yandex (deezer was separately re-probed with `country=FR`, also nothing). They stay **selectable but unticked** rather than deleted: the failure is Lucida's backend and these have come back before. Enabling a dead one is cheap — the cascade resolves `no-results` on the "uh-oh!" page in about a poll cycle rather than burning the 30s cascade — but it finds nothing, so it only costs seconds per skipped track.

**Test Services** (Settings) re-runs exactly that probe in place, through `#scraper-view`, and writes the per-service result next to each checkbox. It sets `scraperMode = 'service-probe'` for the duration — the shared `dom-ready` handler would otherwise run the Lucida result parser over every probe page — and restores the mode, the user agent and `about:blank` in a `finally`, the same dance `spotifyProfilePlaylists()` does. Prefer it to a throwaway script; the `.search-result` count is the gate, not that the page loaded.

**The two search paths do not build the same URL.** A plain-text search appends `&country=US` (the only `country` in `renderer.js`); `lucidaSearchUrl()` — which builds the URL for *every* Spotify track and *every* fallback re-search — omits `country` entirely. So a query typed into the box and the same query reached through the fallback chain are not the same request, which is worth remembering before concluding a service is dead: hold `country` constant when comparing.

**Detecting an empty result set** — a service with no match does *not* render an `.error` element. It renders the ordinary search scaffold (`Tracks`/`Albums` headings) with zero `.search-result` cards, which is indistinguishable from a slow load. The cascade counts consecutive empty polls once that scaffold exists and calls `no-results` after 16 (~8s). Without it an unavailable track costs the full 30s cascade plus three retries.

**Giving up** — `abandonItem()` marks a track skipped (amber), increments `groupStats[].skipped`, and advances the queue — but only once the fallback chain is exhausted. `handleNoStart()` handles the "nothing began" case for both the 120s wall-clock timer and the cascade's own `timeout` outcome, retrying the same service up to `MAX_START_ATTEMPTS` (3) before falling through. Group progress treats `completed + skipped` as settled so a group can still reach 100%; without this a single unavailable track wedges the queue permanently, since every retry path re-`unshift`s to the front.

**Download queue** — strictly serial, one item at a time (`downloadQueue` + `isProcessingQueue`), and pausable (see *Speed limit and pause/resume*). Items are enqueued through `enqueueAll()`, which checks the whole batch against disk in **one** IPC round trip and then enqueues synchronously — awaiting per item would let the queue order scramble, since the checks resolve out of order. `processNextInQueue` sends `set-next-download-folder` over IPC *before* navigating the download webview, so the main process knows the destination folder when `will-download` fires. Failures and a 120s no-start timeout `unshift` the item back to the front of the queue, bounded by `MAX_START_ATTEMPTS` per service and then the fallback chain. `downloadFileMap` maps the real downloaded filename back to the UI element id, which is why only one download may be in flight. `renderResults()` is the only entry point into the queue, and its bulk **Download All Tracks** button renders only when `isCurrentSearchALink && data.length > 1` — a plain-text search therefore offers per-row buttons and no bulk path.

**Removing** — a remove control sits on each track row, each playlist summary and each profile summary, plus **Remove All** in the Downloads header; all of them funnel into `removeQueueItems(ids)`. Two things make this more than a `delete`:

- **The bar is `settled/total`, so both halves have to come back down.** Removing a *completed* row decrements `completed` as well as `total`, and a *skipped* one decrements `skipped` — drop only `total` and a finished group reads over 100%. Every counter is floored at 0, so removing the same id twice cannot push it negative.
- **Removing the in-flight item has to stop the transfer.** `downloads-cancel` cancels the live `DownloadItem` in the main process, then the renderer repeats the `setQueuePaused` dance — clear the start timer and listener, null `currentProcessingItem`, point `#download-view` at `about:blank` to kill the in-page cascade — and calls `processNextInQueue()` by hand, because nothing else will advance a queue whose current item no longer exists. The `download-status` handler now returns early when `activeDownloads[id]` is gone: the `cancelled` event arrives *after* the removal, and its failure branch would otherwise `unshift` the removed track back onto the queue.

Emptying a playlist prunes its `<details>` and shrinks the owning profile's `expected`; emptying a profile removes it entirely. Because a profile's playlists are queued by a loop that may still be running, `removedGroups` makes an in-flight `queuePlaylist` drop its results, and `expansionEpoch` (bumped by Remove All and by removing a profile) makes `queueAllPlaylists` break out rather than re-add what was just removed.

**Grouping** — items sharing a `group.id` render inside one collapsible `<details>` with an aggregate progress bar, tracked in `groupStats[groupId] = {total, completed, skipped, downloading}` (plus `failed` on a profile playlist that expanded to nothing). Group ids are `'album-'+Date.now()` / `'spotify-'+Date.now()`, or `'<profileId>-pl-<n>'` when the group belongs to a profile (see *User profiles*).

**Oversized embedded artwork** — `stripOversizedArtwork()` in `main.js` runs on every completed download. Lucida serves some FLACs with a huge cover-art PICTURE block, and Windows' FLAC parser gives up on those: Explorer shows no artwork, every media property reads back empty, and the file errors instead of playing. Verified 2026-08-28 — a 2400x2400 / 4.58MB block breaks it, a 1500x1500 / 2.77MB block in a sibling file is fine, so the trigger is block *size*, not the picture, hence `MAX_EMBEDDED_ART = 3MB`. The function walks the FLAC metadata blocks, rewrites the header without any type-6 block over the limit (re-flagging whichever block is now last), and copies the audio frames across untouched in 1MB chunks; it refuses to write a file with no STREAMINFO, and no-ops on anything that is not a `fLaC` file. The folder still gets its `cover.jpg`, so the artwork is not lost — it just no longer lives inside the file. Logged as `artwork.stripped`. It returns `{error}` rather than throwing, and writes through a `.arttmp` rename, so a failed rewrite leaves the original file untouched and surfaces only as an `error` field on that log line.

**IPC surface** — the renderer owns the logic, the main process owns the disk, so every filesystem, network-JSON and download action crosses one of these channels. `grep -n "ipcRenderer\.\(invoke\|send\)(" renderer.js` is the full call list.

| direction | channels |
|---|---|
| invoke (renderer → main, awaited) | `get-config`, `select-directory`, `get-download-path`, `get-log-path`, `queue-load`, `cache-get`, `cache-clear`, `downloads-check`, `http-json` |
| send (renderer → main, fire-and-forget) | `log`, `set-config`, `queue-save`, `queue-clear`, `cache-set`, `set-next-download-folder`, `downloads-pause`, `downloads-resume`, `downloads-cancel`, `report-track` |
| main → renderer | `download-started`, `download-progress`, `download-status`, `throttle-unsupported` |

## User profiles

A profile lookup lists someone's **public playlists** and queues whole playlists rather than single tracks. It is reached three ways, all explicit: the `user:` prefix (`user:thesimulacrum`, with an optional service token — `user:deezer:someone` — that overrides the dropdown), the `#search-mode` dropdown set to *User profile*, or a pasted profile URL. A **bare name is never treated as a username**: `thesimulacrum` is a perfectly good track query, and guessing between the two would break plain search. `parseProfileInput()` normalises all three forms to `{service, user}`; `runProfileSearch()` caches under `profile:<service>:<user lowercased>`, so a second lookup of the same person costs nothing for 7 days.

**Spotify has no usable API here, so the profile is scraped.** Three things were measured on 2026-08-29 and each one is load-bearing:

- **The desktop user agent is required.** With Electron's default UA Spotify serves the *mobile* shell — "Continue in the Spotify app", no grid, zero playlists. `SPOTIFY_DESKTOP_UA` is set as the webview's `useragent` for the profile load and removed afterwards.
- **The consent dialog blocks rendering.** `#onetrust-accept-btn-handler` is polled for and clicked before anything is read.
- **`/api/token` answers 400 to an anonymous caller**, so the web player's own token route is closed and there is no shortcut past the DOM.

`#scraper-view` is shared with Lucida, whose `dom-ready` handler unconditionally injects the Lucida parser. `scraperMode` guards that: point the webview at Spotify without it and the Lucida parser runs against Spotify's DOM, finds nothing for its full ~15s cascade, and resolves `[]` straight over the profile results. `spotifyProfilePlaylists()` restores `scraperMode`, the `useragent` and `about:blank` in a `finally`, so a thrown scrape cannot leave the webview mis-configured for the next Lucida search.

Selectors, verified against a live 130-playlist dump: the shelf is `section[data-testid="component-shelf"][aria-label="Public Playlists"]`, each card title is `p[data-encore-id="cardTitle"]` (130/130) and the artwork is `img[data-testid="card-image"]` (127/130 — a coverless playlist has `card-image-fallback` instead and yields `image: ''`). Every class name on that page is hashed (`e-10810-card`, `laP_1jcT71BPsK3jgXhx`) and must never be selected on. **The `aria-label` is localised**, so the shelf lookup falls back to `document.body`; that fallback is also the risk — on a logged-in session the left sidebar's own `a[href^="/playlist/"]` links would be scraped in as if they were the profile's, so keep the app's Spotify session logged out.

**Deezer goes through the public JSON API instead**, and through the *main process*: `api.deezer.com` sends no `Access-Control-Allow-Origin`, so a renderer `fetch` is blocked where the Spotify embed endpoints allow it. `ipcMain.handle('http-json')` fetches and parses, restricted to a `JSON_HOSTS` allowlist and logged as `http.json` / `http.blocked`. `search/user?q=` works but names are not unique (`john` returns 300 people) and the first hit is taken, so a numeric id — which bypasses the lookup entirely — is the reliable input. Playlists are followed through the API's `next` links rather than a guessed limit.

**Download All puts the profile itself in the queue**, as a third `<details>` level above the playlists:

```
<details> profile      thesimulacrum      — profileStats[pid], summed from its groups
  <details> playlist   one per playlist   — groupStats[gid], created up front
    track rows
```

`beginProfile()` registers the profile *and a group per playlist* before a single track has been fetched, so the button switches to the Downloads tab immediately and every playlist is already there to expand while expansion is still running. A group that has not been reached yet has `total: 0`, which is why `updateGroupUI` has to special-case it — `settled / 0` is `NaN` — and shows `0/?` / "Waiting to expand..." until its tracks arrive; one that expanded to nothing is flagged `failed` and reads "Nothing to download" rather than waiting forever.

**Profile counters are summed, never incremented.** `updateProfileUI()` adds up the `groupStats` of the groups it owns, and the only call site is the tail of `updateGroupUI()`. That is deliberate: every existing path that mutates a group's counters — `markAlreadyDownloaded`, `abandonItem`, the completion handler, `restoreSession` — already calls `updateGroupUI`, so the profile total follows for free and there is no second set of counters to drift out of step. Adding a new group-mutating path needs no profile code at all, provided it keeps calling `updateGroupUI`.

Items carry `profileId` / `profileName` / `profileService`, so `restoreSession()` rebuilds the nesting after a restart. Only playlists that actually produced items are in `queue.json`, so a restored profile's `expected` is the number of groups that come back — which is the right number, since an unexpanded playlist queued nothing to resume. Downloads are **not** nested on disk: `folderFor()` in the main process replaces `/` with `_`, so each playlist still gets its own flat folder, exactly as a pasted album does.

**Scale is the reason playlists are queued, not tracks.** `thesimulacrum` has 130 public playlists; expanding all of them is thousands of tracks and hours of Lucida searching. Each playlist expands to one group, so it lands in the queue exactly like a pasted album.

**Artwork.** A playlist embed's `trackList` entries carry no image at all — only `uri`, `title`, `subtitle`, `duration` and `audioPreview` — so a per-track cover costs one `/embed/track/<id>` fetch each and there is no batch endpoint without auth. That is why every track used to show the playlist cover. It is now fetched for profile playlists as well as pasted ones, through `mapPool(trackList, ART_POOL, ...)`: measured 2026-08-29 on a 22-track playlist, serial took 6716ms and eight at a time took 1057ms with all 22 resolved, and roughly half the covers in a playlist are genuinely distinct. **The cap is the point, not the speed** — the previous `Promise.all(trackList.map(...))` fired one request per track simultaneously, which a profile would then repeat for every playlist it owns. `mapPool` keeps results index-aligned with their inputs, so artwork cannot drift onto the wrong track when a later fetch finishes first.

**The profile avatar is not a playlist cover.** Spotify serves no avatar on either profile route — checked 2026-08-29, zero `ab677657` images on `/user/<id>` or `/user/<id>/playlists` — so `beginProfile` borrowing the first playlist's art made the profile look like one of its own playlists. With no avatar the summary renders a monogram from the username instead; do not reintroduce a cover as a stand-in. Deezer *does* publish one (`picture_medium`, from the search hit or one `user/<id>` call) and it is used when present. Note also that the base `/user/<id>` route renders only a **10-playlist preview shelf** against 130 on `/playlists`, so the scrape URL has to keep the `/playlists` suffix — the base route does carry the display name in `document.title` ("Spotify – Nihil"), which the `/playlists` route does not.

New log events: `profile.start` / `profile.result` (with `outcome`, `playlists`, `cached`) / `profile.error`, plus `http.json` / `http.blocked` from the main process.

## Persistent state

`state/` sits next to `logs/` and is written **only by the main process**, same as the log. Four things live there, and the split matters:

| file | lifetime | holds |
|---|---|---|
| `config.json` | forever | download path, `speedLimitKBps`, `scanFolderForExisting`. The download path used to be picked fresh every launch; resume depends on it being stable |
| `manifest.json` | forever | every completed download keyed by track → `{file, savePath, bytes, at}` |
| `queue.json` | until the queue drains | the whole current session: every item with its status |
| `cache/<sha1-20>.json` | 7 days | finished result lists, keyed by what was pasted (filename is the first 20 hex chars of the key's sha1) |

All four go through `writeJson()`, which writes a temp file and renames — these are read back at startup, and truncated JSON from a crash mid-write would lose the queue it exists to protect. `saveQueue`/`saveManifest` are debounced; the debounce carries `.flush()` (called on `window-all-closed`, so a pending write lands before the process goes) and `.cancel()` (called by `queue-clear`, or the in-flight write would recreate the file the renderer just cleared).

**Resume across restarts** — the renderer calls `persistSoon()` on every queue transition, snapshotting `activeDownloads` (each item plus its status). On launch `restoreSession()` reloads it and *reconciles against disk* rather than trusting it: every item is re-checked with `downloads-check`, so a track completed last run renders as done and one whose file has since been deleted quietly re-queues. Group totals are pre-populated before the first row is rendered — `addDownloadToUI` prints `groupStats[gid].total` into the summary — and already-downloaded items count as `completed`, or a part-finished album would read 4/10 for ever. Previously skipped items **stay skipped**: a skip means the fallback chain was exhausted, and re-running it every launch pays the full per-service budget to reach the same answer. `queue.json` is deleted once nothing is left unsettled, so a finished session does not replay on the next launch.

**"Already downloaded?" (`checkDownloaded`)** — the manifest is the authority: it holds the real save path, so an existing file is a fact rather than a guess, and a file the user deleted correctly downloads again (the stale entry is pruned on the spot). The key is `folderName|title|artist`, normalised — deliberately *not* the Lucida url, since the same track is reached through a different url on every fallback service. The optional folder scan (`scanFolderForExisting`, **off by default**) is only for files this app never recorded, and requires every title token to appear as a whole token in the filename with at least two tokens to match on; single-word titles are refused outright. It stays off by default because a filename match can only ever be a guess, and a wrong guess silently skips a track the user wanted.

**Scrape cache** — a Spotify playlist costs one embed fetch for the track list plus one *per track* for artwork, so re-pasting a 130-track link is 131 round trips before any audio moves. `searchBtn` checks `cache-get` before it touches the network or the scraper webview and short-circuits on a hit; the scraper's `dom-ready` writes back through `pendingScrapeKey`. Cache hits go through `freshGroupIds()` — a cached list carries the group id it was scraped with, and reusing it would fold a second download of the same album into the first one's progress bar.

The key is `kind + ':' + query` (`spotify`|`url`|`text`), and **carries no service** — harmless today because plain-text search is always Qobuz, but adding the `#service-select` dropdown described under *Service selection* without extending the key would serve a stale per-service result list for up to 7 days. Nothing prunes the directory either: the TTL only stops an entry being *served*, and Settings → Clear Cache (`cache-clear`) is what actually deletes files.

## Per-folder download report

Every download folder gets a `_lucidafetcher.json` next to the audio and the `cover.jpg`, answering the question `state/manifest.json` cannot: **what is this folder missing, and what was tried before giving up?** The manifest is keyed for the app's own "do I already have this?" check and lives next to the code; the queue file is deleted the moment it drains, and the session log is per run. Without this, a skipped track leaves no trace anywhere the user will ever look.

```json
{
  "app": "LucidaFetcher", "folder": "Random Access Memories",
  "created": "...", "updated": "...",
  "counts": { "downloaded": 12, "missing": 1 },
  "downloaded": [{ "at", "title", "artist", "service", "sourceUrl", "file", "bytes", "via", "tried" }],
  "missing":    [{ "at", "title", "artist", "group", "searchQuery", "reason", "detail", "lastUrl", "tried" }]
}
```

`tried` is the per-track service history — `[{service, outcome, at}]` — accumulated by `recordTried()` as `tryFallbackOrAbandon` moves down the chain and closed off by `abandonItem`. It is the same list the fallback logic reads to avoid re-searching a store, so the report cannot drift from what actually happened.

Load-bearing details:

- **Two writers, one function.** `writeReport()` in `main.js` is the only thing that touches these files (same rule as everything under `state/`: one writer, atomic temp+rename via `writeJson`, survives a renderer crash). It is called directly from the `will-download` `done` handler — only the main process knows the final filename and byte count — and over the `report-track` IPC channel from `abandonItem()` and `markAlreadyDownloaded()`, which are the only paths the main process cannot see.
- **The metadata rides on `set-next-download-folder`.** That context already crossed to the main process before each navigation, so it now carries `title` / `artist` / `service` / `sourceUrl` / `tried` alongside the folder and key. Nothing else in the main process knows which queue item a download belongs to.
- **A track appears once, in one section.** Entries are keyed by `normTokens(title)|normTokens(artist)`, and a write removes the key from *both* arrays first — so a track that was missing and is later found moves across rather than appearing twice.
- **`via: 'existing-*'` keeps the original `at`.** `restoreSession()` re-reports every already-downloaded item on every launch; bumping the timestamp each time would destroy the one fact nothing else records — when the track was actually fetched. A real re-download (`via: 'download'`) does update it.
- **The folder is created even when nothing downloaded.** A group whose every track failed never had a folder made by `will-download`, and that is precisely the run worth having a record of, so `writeReport` `mkdir`s first.
- **Tracks with no group report at the download root**, since `folderFor(null)` is `downloadPath` — that is where a single track from a plain-text search lands.
- Reports are written with 2-space indent (`writeJson(file, value, 2)`); `state/` files stay compact. A corrupt or foreign file at that path is replaced rather than thrown on, via the usual `readJson` fallback — which does mean its earlier entries are lost.

Verified with a harness that extracts `writeReport` from `main.js` and runs it against a temp dir with `downloadPath` stubbed (same extract-and-run pattern as *Testing the injected matcher*, and likewise not kept in the repo): the two sections, missing→downloaded promotion, `at` preservation vs. bump, folder creation for a wholly-failed group, root-level reports, and recovery from a truncated file.

## Speed limit and pause/resume

Electron exposes **no bandwidth cap on a `DownloadItem`**, so `throttleTick()` duty-cycles `pause()`/`resume()` against a byte budget refilling at `speedLimitKBps`, on a 500ms tick. It averages out over about a second rather than smoothing every packet. The budget is capped at one second of headroom, or a long pause would be followed by an unthrottled burst as it drains.

`resume()` is the hazard: a server that will not honour a range request makes Chromium discard what it has and start over, which at this frequency is a download that never finishes. So the tick watches for the byte count going *backwards* after a resume and, if it ever does, sets `throttleSupported = false` for the rest of the session and tells the renderer to say so in Settings. **Default is 0 (unlimited), which bypasses the mechanism entirely** — this has not been proven against Lucida's file host, so treat a non-zero limit as the unverified path.

Pause is two things at once. The main process pauses the live `DownloadItem` (`userPaused` outranks the limiter, and refuses to let the budget refill while stopped); the renderer sets `queuePaused`, which makes `processNextInQueue` return **before** it shifts, so pausing never consumes an item. If the current item has not reached a download yet, `setQueuePaused` puts it back at the front and points the download webview at `about:blank` — the injected cascade is still polling in there, and letting it reach a click while paused would start the very download the user just stopped. Its `attempts` is deliberately not incremented: a pause is not a failed attempt, and burning the budget would push the track onto the fallback chain for nothing.

## Session logging

Every run appends to `logs/session-<ISO timestamp>.jsonl` (under `app.getAppPath()`, i.e. the repo root) — one JSON object per line. The path is shown in the Settings tab. **The main process is the only writer**: the renderer forwards events on the `log` IPC channel, which keeps ordering stable and preserves the log if the renderer dies. `logs/` is never pruned, so delete old sessions by hand.

Every record has `ts` (wall clock), `t` (ms since session start) and `evt`. The useful events:

| event | carries |
|---|---|
| `session.start` / `session.config` | electron+chrome versions, download path, and the tuning knobs (`FALLBACK_SERVICES`, `MIN_TITLE_SCORE`, `MAX_START_ATTEMPTS`, `startTimeoutMs`, `cascadePolls`, `emptyPollsBeforeNoResults`) so a log is self-describing |
| `session.end` / `settings.downloadPath` / `settings.change` / `error.main` | uptime; a changed download directory; a changed setting; an uncaught main-process throw |
| `session.restore` | on launch: how many items came back, and the split between `requeued` / `alreadyDone` / `skipped` |
| `state.error` | a `state/` file that could not be written - the queue is not being saved |
| `search.start` / `search.result` / `search.error` | query, `kind` (spotify\|url\|text\|scrape), track count, ms |
| `queue.add` | `id`, title, artist, `searchQuery`, url, group |
| `attempt.start` | `id`, `service`, `fallbackIndex`, attempt number, queue depth |
| `attempt.outcome` | `navigating` \| `no-match` \| `no-results` \| `timeout` \| `clicked-*`, plus ms |
| **`match.candidates`** | what was wanted vs the **top 5 hits with their `t`/`a` scores** — the record to mine when tuning `MIN_TITLE_SCORE` |
| `fallback` / `retry` / `skip` | service transitions, reasons, and which services were tried (`skip.servicesTried` is now the real per-item list from `item.tried`, not a slice of the chain) |
| `services.test.start` / `services.test` / `services.test.result` | the Settings probe: per service, `cards` and any error text, then the list that answered |
| `report.write` / `report.error` | a folder's `_lucidafetcher.json` updated (with its running counts), or the folder could not be written |
| `skip.exists` | a track settled without downloading, with `via` (`manifest` = exact record, `scan` = filename guess) |
| `queue.pause` / `queue.resume` | the queue stopping and starting, with its depth |
| `queue.remove` / `queue.remove.all` | items removed by hand: how many, `reason` (`row`\|`group`\|`profile`), and whether the live item went with them |
| `download.cancel` | a live transfer cancelled in the main process because its item was removed |
| `cache.hit` / `cache.clear` | a search that cost no network at all, with the entry's age |
| `download.start` / `download.progress` / `download.done` / `download.interrupted` | bytes, ms, `kbps`; progress is sampled every 10s, not per tick |
| `artwork.stripped` | `removedBytes` when a FLAC's oversized cover block was rebuilt out, or `error` if the rewrite failed |
| `download.pause` / `download.resume` | an explicit pause reaching the live transfer |
| **`download.throttle.unsupported`** | the limiter switched itself off: this server restarts a transfer rather than resuming it. Everything after this point ran unthrottled |
| `download.mapped` / `item.done` | ties the main process's *filename* back to the renderer's queue `id` |
| `console.warn` / `console.error` / `error.uncaught` / `error.rejection` | renderer console is mirrored, so failures show up without the devtools open |

Reading a log — the `id` field threads one track through the whole run:

```bash
# what happened, in order, for every track
node -e "require('fs').readFileSync(process.argv[1],'utf8').trim().split('\n').map(JSON.parse) \
  .filter(l=>/^(attempt|fallback|retry|skip|item)\./.test(l.evt)) \
  .forEach(l=>console.log((l.t/1000).toFixed(1)+'s', l.evt, l.name||'', l.service||'', l.outcome||l.reason||''))" logs/session-*.jsonl

# near-misses: everything the matcher rejected, with scores
grep '"evt":"match.candidates"' logs/*.jsonl | grep '"accepted":false'
```

When mining a run for improvements, the questions the schema is built to answer: which services actually returned anything; how often `no-match` was a genuine miss versus a threshold that is too strict (compare `t`/`a` in `match.candidates` against `MIN_TITLE_SCORE`); where wall-clock time went (`attempt.outcome.ms`, `download.mapped.msToStart`); and whether any track burned its whole attempt budget.

## Testing the injected matcher

There is no test runner, and `node --check` cannot see inside the template literals, so the matcher is verified by pulling the literal out of `renderer.js` and running it against fake DOM nodes in plain Node. Write the harness into a scratch dir, not the repo:

```js
const fs = require('fs');
const src = fs.readFileSync('renderer.js', 'utf8');
// the injected scorer, from the interpolated MIN_TITLE_SCORE down to the click cascade
const body = src.slice(src.indexOf('const MIN_TITLE_SCORE = ${'),
                       src.indexOf('// 4. Text fallbacks.'));
const scope = body.replace(/\$\{MIN_TITLE_SCORE\}/g, '0.6');   // undo the interpolation
// then stub what the script reaches for - document.querySelectorAll('.search-result')
// returning objects whose .querySelector gives the candidate title/artist text -
// and assert the t/a scores for known good and known bad pairs.
```

The cases worth keeping: an `ALTERING` marker on one side only must zero the title score ("No Glory" vs "No Glory (Remix)"), a shared surname must not satisfy the artist gate ("Joel Nielsen" vs "Billy Joel"), and a stroked or ligature letter must not shatter a token (`ł`, `ø`, `æ`, `ß` go through `FOLD`, not NFD). Delete the harness afterwards — nothing in the repo is expected to import it.

## Re-deriving selectors when Lucida changes

Lucida ships no API and no versioning, so a silent DOM change is the expected failure mode: results stop parsing, or the download click cascade never fires. To re-derive selectors, write a throwaway script that opens a *visible* `BrowserWindow` on the failing URL, waits ~8s for client-side render, dumps `document.body.innerHTML` to a file, and quits:

```js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
// share the real app's profile so Cloudflare clearance cookies carry over
app.setPath('userData', require('path').join(app.getPath('appData'), 'lucidafetcher'));
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: true, width: 1024, height: 768 });
  win.loadURL('https://lucida.to/search?query=test&service=qobuz&country=US');
  win.webContents.on('did-finish-load', () => setTimeout(async () => {
    fs.writeFileSync('dump.html', await win.webContents.executeJavaScript('document.body.innerHTML'));
    app.quit();
  }, 8000));
});
```

Run it with `npx electron <file>.js`. Reusing the `lucidafetcher` userData profile matters — a fresh profile hits the Cloudflare interstitial instead of the page. Spotify metadata needs no browser: `fetch` the `/embed/` URL in plain Node and regex out the `__NEXT_DATA__` script tag. Delete these probes once the selectors are back in `renderer.js`.

## Service selection

Note this is separate from the **fallback** chain, which *is* configurable (Settings → Fallback Services, see *Service fallback*). What is still hardcoded is which service a *search* is aimed at in the first place.

Plain-text search reads `serviceSelect?.value` and falls back to `'qobuz'`. `index.html` has no `#service-select` element yet, so every search is currently Qobuz; adding a `<select id="service-select">` is enough to activate the choice. Note the Spotify path hardcodes `&service=qobuz` when it builds per-track Lucida search URLs — wire that up too if you add the dropdown, or the setting will silently not apply to Spotify links.
