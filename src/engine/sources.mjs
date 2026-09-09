// Turning a pasted link into a list of tracks.
//
// Ported out of renderer.js so the React UI can import a playlist without the
// old DOM around it. Every transport is injected - `fetch` for the public embed
// endpoints, `httpJson` for Deezer's API (which goes through the main process to
// dodge CORS), and an optional `scraper` for the one flow that genuinely needs a
// browser page - so the parsing is testable without Electron.

import { buildSearchQuery } from './variants.mjs';
import { lucidaSearchUrl } from './worker.mjs';

export function sanitizeFolder(name) {
  return String(name || '').replace(/[<>:"/\\|?*]+/g, '').trim() || 'Playlist';
}

// A profile download writes one folder per playlist INSIDE a folder named after
// the user, so `folderName` has to be able to say "two levels deep". A forward
// slash is the separator on both platforms here: main.js re-splits on it and
// sanitizes each segment on its own, so the string never has to know what the
// filesystem calls a separator.
export function joinFolder(...parts) {
  // Empty parts are dropped BEFORE sanitizing, not after: sanitizeFolder turns
  // '' into 'Playlist', so filtering afterwards would invent a folder nobody
  // asked for and bury a loose playlist one level too deep.
  return parts
    .filter((p) => String(p == null ? '' : p).trim())
    .map((p) => sanitizeFolder(p))
    .join('/');
}

/**
 * The orders a profile's playlists can be downloaded in.
 *
 * `tracks` sorting is only honest AFTER each playlist has been read - a scraped
 * profile grid carries a count for some cards and none for others - so the
 * profile flow resolves first and sorts second, and this function is handed the
 * real counts.
 */
export const PROFILE_ORDERS = [
  { id: 'default', label: 'As listed on the profile' },
  { id: 'new-old', label: 'Newest first' },
  { id: 'old-new', label: 'Oldest first' },
  { id: 'more-less', label: 'Most tracks first' },
  { id: 'less-more', label: 'Fewest tracks first' },
  { id: 'name-asc', label: 'Name A-Z' },
  { id: 'name-desc', label: 'Name Z-A' },
];

const orderTime = (p) => {
  const raw = p && (p.addedAt || p.createdAt);
  if (!raw) return null;
  const t = typeof raw === 'number' ? raw : Date.parse(String(raw).replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
};

/**
 * Pure, and deliberately stable: every comparison falls back to the profile's
 * own order, so two playlists with the same track count keep the order the user
 * saw on the grid rather than swapping about between runs.
 */
export function sortPlaylists(list, order = 'default') {
  const rows = (list || []).map((p, i) => ({ p, i }));
  const times = rows.map((r) => orderTime(r.p));
  const haveTimes = times.some((t) => t != null);
  const by = (score) => rows.slice().sort((a, b) => (score(a) - score(b)) || (a.i - b.i)).map((r) => r.p);
  const count = (r) => Number(r.p.tracks) || 0;
  // With no dates at all the grid order IS the recency order on both services:
  // newest first. That is not a guess about the data - it is the only ordering
  // information a scraped profile page carries, and saying so beats refusing to
  // offer the sort.
  const age = (r) => (haveTimes ? -(times[r.i] == null ? -Infinity : times[r.i]) : r.i);
  const name = (r) => String(r.p.name || '');

  switch (order) {
    case 'new-old':   return by(age);
    case 'old-new':   return by((r) => -age(r));
    case 'more-less': return by((r) => -count(r));
    case 'less-more': return by(count);
    case 'name-asc':  return rows.slice().sort((a, b) => name(a).localeCompare(name(b)) || (a.i - b.i)).map((r) => r.p);
    case 'name-desc': return rows.slice().sort((a, b) => name(b).localeCompare(name(a)) || (a.i - b.i)).map((r) => r.p);
    default:          return rows.map((r) => r.p);
  }
}

// "user:thesimulacrum" is the typed form of the profile mode. It is a prefix and
// not a guess, which is the point: a bare "thesimulacrum" has to stay a track
// query. An optional service token overrides the default - "user:deezer:someone".
const USER_PREFIX = /^user:\s*/i;

// A link yt-dlp can read directly: one upload, or a whole set/album/playlist.
// The YouTube half is deliberate - the app already downloads from YouTube as a
// last resort, so a pasted YouTube link had no reason to be refused.
const MEDIA_LINK = /^https?:\/\/(?:[\w-]+\.)*(?:soundcloud\.com|snd\.sc|youtube\.com|youtu\.be)\//i;

export function parseProfileInput(raw, service) {
  let q = String(raw || '').trim();
  let forced = null;
  if (USER_PREFIX.test(q)) {
    q = q.replace(USER_PREFIX, '').trim();
    const svc = /^(spotify|deezer)\s*:\s*/i.exec(q);
    if (svc) { forced = svc[1].toLowerCase(); q = q.slice(svc[0].length).trim(); }
    if (!q) return null; // "user:" with nothing after it
  }
  let m = /open\.spotify\.com\/user\/([^/?#]+)/i.exec(q);
  if (m) return { service: 'spotify', user: decodeURIComponent(m[1]) };
  m = /deezer\.com\/(?:[a-z]{2}\/)?profile\/(\d+)/i.exec(q);
  if (m) return { service: 'deezer', user: m[1] };
  if (/^https?:/i.test(q)) return null; // some other link - not a profile
  return { service: forced || service || 'spotify', user: q };
}

// What the user can tell us the input IS, rather than leaving it to be guessed.
// Auto-detection cannot read a bare word: "amelia" is a valid track query and a
// valid Spotify handle, and the heuristic has to pick one. The mode moves that
// decision to the person who knows the answer.
export const INPUT_MODES = [
  { id: 'auto', label: 'Auto-detect', hint: 'Links, user: profiles, or Artist - Title lines' },
  { id: 'spotify-profile', label: 'Spotify profile', hint: 'A Spotify username or profile link' },
  { id: 'tracks', label: 'Track names', hint: 'One Artist - Title per line' },
];

/**
 * What kind of thing was pasted. Returning a descriptor rather than acting on it
 * keeps the decision visible to the UI, which has to explain it to the user.
 *
 * `mode` is one of INPUT_MODES. Anything but 'auto' skips the guessing entirely -
 * a forced mode is the user's statement of intent, so a bare word becomes a
 * profile handle or a track query with no ambiguity left to resolve.
 */
export function classifyInput(raw, mode = 'auto') {
  const q = String(raw || '').trim();
  if (!q) return { kind: 'empty' };

  if (mode === 'tracks') return { kind: 'text', text: q };
  if (mode === 'spotify-profile') {
    // A pasted Deezer profile URL still reads as Deezer: it is unambiguous, and
    // honouring the dropdown over it would only produce a lookup that fails.
    const parsed = parseProfileInput(q, 'spotify');
    return parsed ? { kind: 'profile', ...parsed } : { kind: 'unknown' };
  }

  const profile = /^user:/i.test(q) || /open\.spotify\.com\/user\//i.test(q) || /deezer\.com\/(?:[a-z]{2}\/)?profile\//i.test(q);
  if (profile) {
    const parsed = parseProfileInput(q);
    return parsed ? { kind: 'profile', ...parsed } : { kind: 'unknown' };
  }

  let m = /open\.spotify\.com\/(?:embed\/)?(playlist|album)\/([A-Za-z0-9]+)/i.exec(q);
  if (m) return { kind: 'spotify-playlist', id: m[2], url: q.split('?')[0], type: m[1].toLowerCase() };

  m = /deezer\.com\/(?:[a-z]{2}\/)?(playlist|album)\/(\d+)/i.exec(q);
  if (m) return { kind: 'deezer-playlist', id: m[2], type: m[1].toLowerCase() };

  // SoundCloud and YouTube are handled as one kind because one tool reads both:
  // yt-dlp resolves a single upload and a whole set through the same call, and
  // the app treats what comes back identically either way.
  if (MEDIA_LINK.test(q)) return { kind: 'media-link', url: q };

  if (/^https?:/i.test(q)) return { kind: 'link', url: q };
  return { kind: 'text', text: q };
}

export function buildTrackResult(title, artist, image, group, service = 'qobuz', extra = {}) {
  return {
    link: lucidaSearchUrl(buildSearchQuery(title, artist), service),
    image: image || group.artworkUrl || '',
    texts: [title, artist].filter(Boolean),
    group,
    ...extra,
  };
}

// An upload's title is the only place its artist reliably appears: SoundCloud's
// uploader field is an ACCOUNT ("Phonk Records", "user-482913"), which is the
// label or a re-poster at least as often as it is the artist. So a dashed title
// is read as "Artist - Title" and the account kept only as a fallback - and the
// scorer checks the artist against both fields of every candidate anyway, so a
// wrong guess here costs nothing but a slightly worse-looking row.
export function splitUploadTitle(entry) {
  const raw = String((entry && entry.title) || '').trim();
  const uploader = String((entry && entry.uploader) || '').trim();
  const parts = raw.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  }
  return { artist: uploader, title: raw };
}

// Spotify does not agree with itself on how an image states its size: a
// playlist's coverArt.sources uses `width`, while a track's visualIdentity.image
// uses `maxWidth`. Reducing on `width` alone therefore compared 0 against 0 for
// every track image and simply kept the LAST entry - which is a 64px thumbnail
// whenever the array is not ordered smallest-last. Read both, and fall back to
// the last entry only when neither is present.
export function largestImage(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const size = (i) => (i && (i.width || i.maxWidth || i.height || i.maxHeight)) || 0;
  return list.reduce((a, b) => (size(a) >= size(b) ? a : b)).url || '';
}

// Deezer's playlist rows already carry the track's own album, so per-track
// artwork here costs NOTHING - no extra request, unlike Spotify below. Using the
// playlist cover for every row, as this used to, was simply throwing away a
// field the response had already paid for. An album's tracklist rows carry no
// album object (they all share one cover by definition), so that path falls
// through to the group artwork, which is the right picture anyway.
export function deezerTrackCover(t) {
  const a = (t && t.album) || {};
  return a.cover_xl || a.cover_big || a.cover_medium || a.cover
    || (a.md5_image
      ? `https://e-cdns-images.dzcdn.net/images/cover/${a.md5_image}/500x500-000000-80-0-0.jpg`
      : '');
}

// Spotify's embed exposes no artwork on a playlist's trackList entries - only
// uri/title/subtitle/duration - so per-track covers cost one /embed/track fetch
// each and there is no batch endpoint without auth. Measured over a 22-track
// playlist: serial 6716ms, eight at a time 1057ms. The cap matters more than the
// speed: Promise.all over a whole trackList fires one request per track at once,
// and a profile does that for every playlist it holds.
export const ART_POOL = 8;

export function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  return Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker)).then(() => out);
}

const NEXT_DATA = /<script id="__NEXT_DATA__".*?>([^<]+)<\/script>/;

// Spotify serves a stripped page - no playlist grid at all - to Electron's
// default user agent. The profile scrape has to look like a desktop browser.
export const SPOTIFY_DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  + ' (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export function createSources({ fetch: doFetch, httpJson, scraper, resolveMedia, cache, log = () => {} } = {}) {
  const f = doFetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);

  // Reading one album is a yt-dlp call plus one oEmbed request PER TRACK, so
  // re-opening the same album - which is what a grid of them invites - costs the
  // whole thing again and is what got this machine rate-limited to a 403 in the
  // first place. The result is keyed by the URL and by whether artwork was asked
  // for, since the cheap variant holds none of it.
  const memo = new Map();
  async function cached(key, make) {
    if (memo.has(key)) return memo.get(key);
    if (cache && cache.get) {
      try {
        const hit = await cache.get(key);
        if (hit) { memo.set(key, hit); return hit; }
      } catch (e) { /* a cold cache is not an error */ }
    }
    const value = await make();
    // Only a good answer is worth keeping: caching "private or removed" would
    // make a transient 403 permanent for a week.
    if (value && !value.error) {
      memo.set(key, value);
      if (cache && cache.set) { try { cache.set(key, value); } catch (e) { /* best effort */ } }
    }
    return value;
  }

  async function spotifyEmbedData(url) {
    const embedUrl = url.replace('open.spotify.com/', 'open.spotify.com/embed/');
    const res = await f(embedUrl);
    const html = await res.text();
    const match = html.match(NEXT_DATA);
    if (!match) return null;
    return JSON.parse(match[1]);
  }

  /** Per-track artwork is opt-in: affordable for one playlist, ruinous for a
   *  profile with a hundred. Without it every track carries the playlist cover,
   *  which is what ends up in cover.jpg anyway. */
  async function spotifyPlaylist(url, opts = {}) {
    const status = opts.onStatus || (() => {});
    try {
      const data = await spotifyEmbedData(url);
      if (!data) return { error: 'Failed to extract tracks from that Spotify link.' };

      const entity = data.props?.pageProps?.state?.data?.entity;
      const trackList = entity?.trackList || [];
      if (!trackList.length) return { error: 'No tracks found on that Spotify link.' };

      const sources = entity?.coverArt?.sources;
      let defaultCover = opts.cover || '';
      if (!defaultCover && sources && sources.length) {
        defaultCover = largestImage(sources);
      }
      const playlistName = opts.playlistName || entity?.name || 'Spotify Playlist';

      let images = trackList.map(() => defaultCover);
      if (opts.perTrackArtwork) {
        status('Fetching track artwork…');
        images = await mapPool(trackList, ART_POOL, async (t) => {
          const trackId = String(t.uri || '').split(':').pop();
          try {
            const d = await spotifyEmbedData('https://open.spotify.com/track/' + trackId);
            const imgs = d?.props?.pageProps?.state?.data?.entity?.visualIdentity?.image;
            const best = largestImage(imgs);
            if (best) return best;
          } catch (e) { /* fall back to the playlist cover */ }
          return defaultCover;
        });
      }

      const group = {
        id: 'spotify-' + Date.now(),
        name: playlistName,
        folderName: sanitizeFolder(playlistName),
        artworkUrl: defaultCover,
      };
      log('source.spotify', { name: playlistName, tracks: trackList.length });
      return {
        name: playlistName,
        group,
        results: trackList.map((t, i) => buildTrackResult(t.title, t.subtitle || '', images[i], group)),
      };
    } catch (e) {
      return { error: 'Error fetching Spotify metadata: ' + e.message };
    }
  }

  // Deezer paginates through a 'next' link; follow it rather than guessing a limit.
  async function deezerPaged(url, maxPages = 20) {
    const out = [];
    let next = url;
    for (let i = 0; i < maxPages && next; i++) {
      const page = await httpJson(next);
      if (!page || !page.data || !page.data.length) break;
      out.push(...page.data);
      next = page.next || null;
    }
    return out;
  }

  async function deezerPlaylist({ id, type = 'playlist', name, image }) {
    try {
      let meta = { title: name, picture_xl: image };
      if (!name) {
        meta = (await httpJson(`https://api.deezer.com/${type}/${id}`)) || {};
      }
      const rows = await deezerPaged(`https://api.deezer.com/${type}/${id}/tracks?limit=200`);
      if (!rows.length) return { error: 'No tracks on that Deezer link.' };

      const title = meta.title || name || 'Deezer Playlist';
      const cover = image || meta.picture_xl || meta.picture_big || meta.cover_xl || '';
      const group = {
        id: 'deezer-' + Date.now(),
        name: title,
        folderName: sanitizeFolder(title),
        artworkUrl: cover,
      };
      log('source.deezer', { name: title, tracks: rows.length });
      return {
        name: title,
        group,
        results: rows.map((t) => buildTrackResult(
          t.title || '', t.artist?.name || '', deezerTrackCover(t), group)),
      };
    } catch (e) {
      return { error: 'Deezer fetch failed: ' + e.message };
    }
  }

  async function deezerProfilePlaylists(user) {
    const rows = await deezerPaged(`https://api.deezer.com/user/${user}/playlists?limit=100`);
    // The avatar and the display name are a separate object from the playlists;
    // failing to read it costs a picture, not the import.
    let me = null;
    try { me = await httpJson(`https://api.deezer.com/user/${user}`); } catch (e) { me = null; }
    return {
      profile: {
        service: 'deezer',
        user: String(user),
        name: (me && me.name) || String(user),
        image: (me && (me.picture_xl || me.picture_big || me.picture_medium)) || '',
        url: (me && me.link) || `https://www.deezer.com/profile/${user}`,
      },
      playlists: rows.map((p) => ({
        id: String(p.id), name: p.title || String(p.id),
        image: p.picture_xl || p.picture_big || '', tracks: p.nb_tracks || 0, service: 'deezer',
        addedAt: p.time_add ? p.time_add * 1000 : null,
        createdAt: p.creation_date || null,
      })),
    };
  }


  // The only flow that needs a real browser page: Spotify's profile grid is
  // rendered client-side and lazy-loads against a bottom sentinel.
  async function spotifyProfilePlaylists(user, onStatus) {
    if (!scraper) throw new Error('A browser page is required to read a Spotify profile.');
    const url = 'https://open.spotify.com/user/' + encodeURIComponent(user) + '/playlists';
    if (onStatus) onStatus('Opening ' + user + ' on Spotify…');
    const res = await scraper.run(url, SPOTIFY_PROFILE_SCRAPE, SPOTIFY_DESKTOP_UA);
    if (!res || res.outcome !== 'ok') {
      // The three failures need different words: an empty profile is the user's
      // answer, a missing shelf usually means the page was served without the
      // grid (wrong user agent, or the profile is private).
      if (res && res.outcome === 'empty') return { error: `${user} has no public playlists.` };
      if (res && res.outcome === 'no-shelf') {
        return { error: `Spotify did not show any playlists for “${user}”. Check the name, and that the profile’s playlists are public.` };
      }
      return { error: 'Could not read that Spotify profile.' };
    }
    // The avatar comes off the same page render as the grid, so it costs no
    // extra request - the old code simply threw the header away and left the
    // profile card showing a placeholder for a picture already on screen.
    const header = res.profile || {};
    return {
      profile: {
        service: 'spotify',
        user,
        name: header.name || user,
        image: header.image || '',
        url,
      },
      playlists: res.items.map((p) => ({ ...p, service: 'spotify' })),
    };
  }

  /**
   * A SoundCloud or YouTube link, resolved through yt-dlp in the main process.
   *
   * Every track keeps the URL of the exact upload it came from, which is the
   * point: the chain can fetch THAT file rather than searching for a name that
   * can only ever be a worse guess at what the user already pointed at. The
   * search stages still sit behind it, so a private or geo-blocked upload falls
   * through to the stores instead of failing the track outright.
   */
  async function mediaLink(url, opts = {}) {
    if (!resolveMedia) return { error: 'Reading that link needs the desktop app.' };
    return cached(`media:${opts.perTrackArtwork ? 'art' : 'plain'}:${url}`, () => readMediaLink(url, opts));
  }

  async function readMediaLink(url, opts) {
    const status = opts.onStatus || (() => {});
    status('Reading the link…');
    const out = await resolveMedia(url);
    if (!out || out.error) return { error: (out && out.error) || 'Could not read that link.' };

    const entries = out.entries || [];
    if (!entries.length) return { error: 'No tracks behind that link.' };

    const isSet = out.kind === 'playlist';
    const name = out.title || (isSet ? 'Playlist' : entries[0].title) || 'Playlist';
    // A single track goes to a folder named after the track's own artist, not
    // after the track: a folder per song would litter the library.
    const first = splitUploadTitle(entries[0]);
    const folderTitle = isSet ? name : (first.artist || out.uploader || name);

    // yt-dlp's --flat-playlist gives a SoundCloud row neither a thumbnail nor,
    // inside a set, a title at all - only a permalink, so the rows arrive as
    // slugs over placeholders. SoundCloud's public oEmbed endpoint answers with
    // both for one request per row: the same trade already made for Spotify
    // track artwork, opt-in for the same reason.
    const thin = (e) => (!e.thumbnail || e.titleGuess) && /soundcloud\.com|snd\.sc/i.test(e.url || '');
    if (opts.perTrackArtwork && httpJson && entries.some(thin)) {
      status('Fetching track details…');
      await mapPool(entries, ART_POOL, async (e) => {
        if (!thin(e)) return;
        try {
          const d = await httpJson('https://soundcloud.com/oembed?format=json&url=' + encodeURIComponent(e.url));
          if (!d) return;
          if (d.thumbnail_url && !e.thumbnail) e.thumbnail = d.thumbnail_url;
          if (!e.uploader && d.author_name) e.uploader = String(d.author_name).trim();
          // oEmbed titles read "Artist - Title by Account"; the trailing account
          // is the uploader, which splitUploadTitle would otherwise take for
          // half of the name.
          if (d.title && e.titleGuess) {
            const author = String(d.author_name || '').trim();
            let t = String(d.title).trim();
            if (author && t.toLowerCase().endsWith((' by ' + author).toLowerCase())) {
              t = t.slice(0, -(author.length + 4)).trim();
            }
            if (t) { e.title = t; e.titleGuess = false; }
          }
        } catch (err) { /* a slug over a placeholder is still a usable row */ }
      });
    }

    const group = {
      id: 'media-' + Date.now(),
      name: isSet ? name : folderTitle,
      folderName: sanitizeFolder(folderTitle),
      artworkUrl: out.thumbnail || entries[0].thumbnail || '',
    };
    log('source.media', { host: (url.split('/')[2] || ''), kind: out.kind, tracks: entries.length });

    return {
      name: group.name,
      group,
      results: entries.map((e) => {
        const { title, artist } = splitUploadTitle(e);
        return buildTrackResult(title, artist, e.thumbnail, group, 'qobuz', {
          mediaUrl: e.url,
          durationSec: e.durationSec || null,
          isSet: !!e.isSet,
        });
      }),
    };
  }

  /** One entry point: hand it whatever the user pasted. */
  async function resolve(input, opts = {}) {
    const c = classifyInput(input, opts.mode);
    switch (c.kind) {
      case 'spotify-playlist': return { ...(await spotifyPlaylist(c.url, opts)), kind: c.kind };
      case 'deezer-playlist':  return { ...(await deezerPlaylist(c)), kind: c.kind };
      case 'media-link':       return { ...(await mediaLink(c.url, opts)), kind: c.kind };
      case 'profile':          return { ...c, kind: 'profile' };
      case 'text':             return { kind: 'text', text: c.text };
      case 'empty':            return { error: 'Nothing to import.' };
      default:                 return { error: 'That link is not a Spotify, Deezer or SoundCloud one.' };
    }
  }

  return {
    resolve, classifyInput,
    spotifyPlaylist, deezerPlaylist, mediaLink,
    spotifyProfilePlaylists, deezerProfilePlaylists,
  };
}

// Injected into the Spotify profile page. Deliberately free of backslashes: this
// is a template literal, so every one would have to be doubled, and node --check
// cannot see in here to tell you when you got it wrong.
export const SPOTIFY_PROFILE_SCRAPE = `
  new Promise((resolve) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const shelf = () => document.querySelector('section[data-testid="component-shelf"][aria-label="Public Playlists"]');
    const anchors = () => Array.from((shelf() || document.body).querySelectorAll('a[href^="/playlist/"]'));

    (async () => {
      // the consent dialog sits over the grid and stops it rendering
      for (let i = 0; i < 40; i++) {
        const btn = document.querySelector('#onetrust-accept-btn-handler');
        if (btn) { btn.click(); break; }
        await sleep(250);
      }

      let waited = 0;
      while (anchors().length === 0 && waited < 40) { await sleep(500); waited++; }
      if (anchors().length === 0) {
        resolve({ outcome: shelf() ? 'empty' : 'no-shelf', items: [], profile: null });
        return;
      }

      // the shelf lazy-loads against a bottom sentinel, so scroll until the count
      // stops growing rather than trusting a single pass
      const scroller = document.querySelector('[data-overlayscrollbars-viewport]')
        || document.scrollingElement;
      let last = -1, stable = 0, rounds = 0;
      while (stable < 3 && rounds < 80) {
        const n = anchors().length;
        if (n === last) stable++; else { stable = 0; last = n; }
        try { scroller.scrollTop = scroller.scrollHeight; } catch (e) { /* no scroller */ }
        await sleep(400);
        rounds++;
      }

      // The profile header. Spotify renders the avatar three different ways
      // depending on which build is served - an <img>, a background-image on a
      // div, or nothing at all until the grid settles - so read all of them and
      // keep og:image as the answer that is always there, because it is
      // server-rendered into the document before any of this runs.
      const meta = (prop) => {
        const el = document.querySelector('meta[property="' + prop + '"]');
        return (el && el.getAttribute('content')) || '';
      };
      const bgUrl = (el) => {
        if (!el) return '';
        const bg = getComputedStyle(el).backgroundImage || '';
        const open = bg.indexOf('(');
        const close = bg.lastIndexOf(')');
        if (open < 0 || close < open) return '';
        return bg.slice(open + 1, close).replace(/["']/g, '').trim();
      };
      // Scoped to a real header element. Falling back to document.body here is
      // what makes an avatar wrong rather than missing: the first <img> in the
      // body of a /playlists page is a PLAYLIST COVER, and it looks plausible
      // enough that nobody notices the profile card is showing the wrong face.
      const header = document.querySelector('[data-testid="entity-header"]') || document.querySelector('header');
      let avatar = '';
      if (header) {
        const hero = header.querySelector('img[data-testid="user-image"]')
          || header.querySelector('figure img')
          || header.querySelector('img');
        if (hero && hero.src && hero.src.indexOf('data:') !== 0) avatar = hero.src;
        if (!avatar) {
          const div = header.querySelector('[data-testid="user-image"]') || header.querySelector('figure > div');
          avatar = bgUrl(div);
        }
      }
      // og:image is server-rendered into the document before any of this runs,
      // so it is the one source that is always there when the header has not
      // painted yet.
      if (!avatar) avatar = meta('og:image');
      const h1 = (header || document).querySelector('h1');
      let ogTitle = meta('og:title');
      const bar = ogTitle.lastIndexOf('|');
      if (bar > 0) ogTitle = ogTitle.slice(0, bar);
      ogTitle = ogTitle.trim();
      const displayName = ((h1 && h1.innerText) || '').trim() || ogTitle;
      const profile = { name: displayName, image: avatar };

      const seen = new Map();
      anchors().forEach((a) => {
        const href = a.getAttribute('href') || '';
        const id = (href.split('/playlist/')[1] || '').split('?')[0];
        if (!id || seen.has(id)) return;
        const titleEl = a.querySelector('p[data-encore-id="cardTitle"]');
        const name = ((titleEl && (titleEl.getAttribute('title') || titleEl.innerText)) || '').trim();
        // the artwork is a sibling within the card, not inside the anchor
        let node = a, img = null;
        for (let k = 0; k < 6 && node && !img; k++) {
          img = node.querySelector('img[data-testid="card-image"]');
          node = node.parentElement;
        }
        // Some builds put "N songs" in the card subtitle. It is a hint for the
        // ordering only - the real count arrives when the playlist is read.
        const subEl = a.querySelector('p[data-encore-id="cardSubtitle"]') || a.querySelector('p:not([data-encore-id="cardTitle"])');
        const subText = ((subEl && subEl.innerText) || '').trim();
        const nMatch = /([0-9][0-9,.]*)[ ]*(songs|tracks)/i.exec(subText);
        const tracks = nMatch ? parseInt(nMatch[1].replace(/[^0-9]/g, ''), 10) : 0;
        seen.set(id, { id: id, name: name || id, image: img ? img.src : '', tracks: tracks || 0 });
      });
      resolve({ outcome: 'ok', items: Array.from(seen.values()), profile: profile });
    })();
  });
`;
