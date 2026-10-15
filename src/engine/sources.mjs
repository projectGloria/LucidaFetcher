// Turning a pasted link into a list of tracks.
//
// Ported out of renderer.js so the React UI can import a playlist without the
// old DOM around it. Every transport is injected - `fetch` for the public embed
// endpoints, `httpJson` for Deezer's API (which goes through the main process to
// dodge CORS), and an optional `scraper` for the one flow that genuinely needs a
// browser page - so the parsing is testable without Electron.

import { buildSearchQuery } from './variants.mjs';
import { lucidaSearchUrl } from './worker.mjs';
import { createSpotifyMetadata } from './spotify-metadata.mjs';

// Reserved DOS device names: illegal as a directory on Windows with or without
// an extension, so a playlist called "AUX" has nowhere to be written. Mirrored
// by WINDOWS_RESERVED in main.js, which resolves the same names to real paths.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeFolder(name) {
  const safe = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '').trim().replace(/[. ]+$/g, '') || 'Playlist';
  return RESERVED.test(safe.split('.')[0].trim()) ? safe.replace(/^([^.]*)/, '$1_') : safe;
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
  let url;
  try { url = new URL(q); } catch { /* typed username */ }
  let m = url?.hostname === 'open.spotify.com' && /^\/(?:intl-[a-z]{2}\/)?user\/([^/]+)(?:\/|$)/i.exec(url.pathname);
  if (m) {
    try { return { service: 'spotify', user: decodeURIComponent(m[1]) }; }
    catch { return null; }
  }
  m = ['deezer.com', 'www.deezer.com'].includes(url?.hostname) && /^\/(?:[a-z]{2}\/)?profile\/(\d+)(?:\/|$)/i.exec(url.pathname);
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

  const profile = /^user:/i.test(q) || /open\.spotify\.com\/(?:intl-[a-z]{2}\/)?user\//i.test(q) || /deezer\.com\/(?:[a-z]{2}\/)?profile\//i.test(q);
  if (profile) {
    const parsed = parseProfileInput(q);
    return parsed ? { kind: 'profile', ...parsed } : { kind: 'unknown' };
  }

  let url;
  try { url = new URL(q); } catch { /* track names are not URLs */ }
  let m = url?.hostname === 'open.spotify.com' && /^\/(?:intl-[a-z]{2}\/)?(?:embed\/)?(playlist|album|track)\/([A-Za-z0-9]+)\/?$/i.exec(url.pathname);
  if (m) return { kind: m[1].toLowerCase() === 'track' ? 'spotify-track' : 'spotify-playlist', id: m[2], url: q.split(/[?#]/)[0], type: m[1].toLowerCase() };

  m = ['deezer.com', 'www.deezer.com'].includes(url?.hostname) && /^\/(?:[a-z]{2}\/)?(playlist|album|track)\/(\d+)\/?$/i.exec(url.pathname);
  if (m) return { kind: m[1].toLowerCase() === 'track' ? 'deezer-track' : 'deezer-playlist', id: m[2], type: m[1].toLowerCase() };

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

// Spotify serves a stripped page - no playlist grid at all - to Electron's
// default user agent. The profile scrape has to look like a desktop browser.
export const SPOTIFY_DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  + ' (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export function createSources({ fetch: doFetch, httpJson, scraper, cache, log = () => {}, spotifyTiming = {} } = {}) {
  const f = doFetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const spotifyEmbedData = createSpotifyMetadata({ fetch: f, cache, log, ...spotifyTiming });
  const trackArtwork = new Map();
  const artworkQueue = [];
  let activeArtwork = 0;
  const pumpArtwork = () => {
    while (activeArtwork < ART_POOL && artworkQueue.length) {
      const task = artworkQueue.shift();
      activeArtwork++;
      task().finally(() => { activeArtwork--; pumpArtwork(); });
    }
  };

  // Share requests across playlists and cap the entire import, not each list.
  // Failed requests are evicted so a later import can repair a missing cover.
  function spotifyTrackArtwork(trackId) {
    if (!trackId) return Promise.resolve('');
    if (trackArtwork.has(trackId)) return trackArtwork.get(trackId);
    const pending = new Promise(finish => {
      artworkQueue.push(async () => {
        let cover = '';
        try {
          const d = await spotifyEmbedData('https://open.spotify.com/track/' + trackId);
          const entity = d?.props?.pageProps?.state?.data?.entity;
          cover = largestImage(entity?.visualIdentity?.image) || largestImage(entity?.coverArt?.sources);
        } catch { /* metadata failure must not discard the track */ }
        if (!cover) trackArtwork.delete(trackId);
        finish(cover);
      });
    });
    trackArtwork.set(trackId, pending);
    pumpArtwork();
    return pending;
  }

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
      const artworkPending = trackList.map(() => true);
      if (opts.perTrackArtwork !== false) {
        status('Fetching track artwork…');
        images = await mapPool(trackList, ART_POOL, async (t, i) => {
          const trackId = String(t.uri || '').split(':').pop();
          const cover = await spotifyTrackArtwork(trackId);
          artworkPending[i] = !cover;
          return cover || defaultCover;
        });
      }

      const group = {
        id: 'spotify-' + new URL(url).pathname.replace(/^\/(?:intl-[a-z]{2}\/)?(?:embed\/)?/, '').replace(/\//g, '-'),
        name: playlistName,
        folderName: sanitizeFolder(playlistName),
        artworkUrl: defaultCover,
        service: 'spotify',
      };
      log('source.spotify', { name: playlistName, tracks: trackList.length });
      return {
        name: playlistName,
        group,
        results: trackList.map((t, i) => buildTrackResult(t.title, t.subtitle || '', images[i], group, 'qobuz', {
          service: 'spotify',
          trackId: String(t.uri || '').split(':').pop() || undefined,
          artworkPending: artworkPending[i],
          durationSec: t.duration ? Math.round(t.duration / 1000) : undefined,
        })),
      };
    } catch (e) {
      return { error: 'Error fetching Spotify metadata: ' + e.message };
    }
  }

  // Deezer paginates through a 'next' link; follow it rather than guessing a limit.
  async function deezerPaged(url, maxPages = 20) {
    const out = [];
    const seen = new Set();
    let next = url;
    for (let i = 0; i < maxPages && next; i++) {
      if (seen.has(next)) break;
      seen.add(next);
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
        id: `deezer-${type}-${id}`,
        name: title,
        folderName: sanitizeFolder(title),
        artworkUrl: cover,
        service: 'deezer',
      };
      log('source.deezer', { name: title, tracks: rows.length });
      return {
        name: title,
        group,
        // The album title rides along where Deezer gives us one. It is what the
        // search-variant builder needs for its disambiguate-by-album wording,
        // which had nothing to work with because nothing on the import side ever
        // carried an album. A playlist NAME is not an album and must not stand
        // in for one - "Track Artist My Chill Mix" is a worse query, not a
        // better one - so this is only ever the track's own.
        results: rows.map((t) => buildTrackResult(
          t.title || '', t.artist?.name || '', deezerTrackCover(t), group, 'qobuz',
          {
            service: 'deezer',
            trackId: t.id ? String(t.id) : undefined,
            isrc: t.isrc || undefined,
            durationSec: t.duration || undefined,
            album: (t.album && t.album.title) || (type === 'album' ? title : ''),
          })),
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

  async function spotifyTrack(url) {
    try {
      const data = await spotifyEmbedData(url);
      const entity = data?.props?.pageProps?.state?.data?.entity;
      const row = entity?.trackList?.[0] || entity;
      const title = row?.title || row?.name;
      const artist = row?.subtitle || entity?.artists?.map(a => a.name).filter(Boolean).join(', ') || '';
      if (!title || !artist) return { error: 'Failed to extract that Spotify track.' };
      const id = new URL(url).pathname.split('/').filter(Boolean).pop();
      const cover = largestImage(entity?.visualIdentity?.image || entity?.coverArt?.sources);
      const group = { id: `spotify-track-${id}`, name: title, folderName: sanitizeFolder(title), artworkUrl: cover, service: 'spotify' };
      return { name: title, group, results: [buildTrackResult(title, artist, cover, group, 'qobuz', {
        service: 'spotify', trackId: id, durationSec: (row.duration || entity.durationInMs) ? Math.round((row.duration || entity.durationInMs) / 1000) : undefined,
      })] };
    } catch (e) { return { error: 'Error fetching Spotify track: ' + e.message }; }
  }

  async function deezerTrack(id) {
    try {
      const row = await httpJson(`https://api.deezer.com/track/${id}`);
      if (!row?.title || !row.artist?.name || row.error) return { error: 'Could not read that Deezer track.' };
      const cover = deezerTrackCover(row);
      const group = { id: `deezer-track-${id}`, name: row.title, folderName: sanitizeFolder(row.title), artworkUrl: cover, service: 'deezer' };
      return { name: row.title, group, results: [buildTrackResult(row.title, row.artist.name, cover, group, 'qobuz', {
        service: 'deezer', trackId: String(row.id || id), isrc: row.isrc, album: row.album?.title, durationSec: row.duration,
      })] };
    } catch (e) { return { error: 'Error fetching Deezer track: ' + e.message }; }
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
    let header = res.profile || {};
    // /playlists is a separate shelf page in newer Spotify builds. The user's
    // avatar lives on /user/:id, so do not substitute a playlist card image.
    if (!header.image) {
      try {
        const root = await scraper.run('https://open.spotify.com/user/' + encodeURIComponent(user), SPOTIFY_PROFILE_HEADER, SPOTIFY_DESKTOP_UA);
        header = { ...header, ...root, name: root?.name || header.name };
      } catch { /* keep a usable playlist import if the header cannot load */ }
    }
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

  async function mediaLink(_url, _opts = {}) {
    return { error: 'YouTube and SoundCloud downloads are disabled. Only FLAC sources are supported.' };
  }

  /** One entry point: hand it whatever the user pasted. */
  async function resolve(input, opts = {}) {
    const c = classifyInput(input, opts.mode);
    switch (c.kind) {
      case 'spotify-track': return { ...(await spotifyTrack(c.url)), kind: c.kind };
      case 'deezer-track': return { ...(await deezerTrack(c.id)), kind: c.kind };
      case 'spotify-playlist': return { ...(await spotifyPlaylist(c.url, opts)), kind: c.kind };
      case 'deezer-playlist':  return { ...(await deezerPlaylist(c)), kind: c.kind };
      case 'media-link':       return { ...(await mediaLink(c.url, opts)), kind: c.kind };
      case 'profile':          return { ...c, kind: 'profile' };
      case 'text':             return { kind: 'text', text: c.text };
      case 'empty':            return { error: 'Nothing to import.' };
      default:                 return { error: 'That link is not a Spotify or Deezer link.' };
    }
  }

  return {
    resolve, classifyInput,
    spotifyPlaylist, deezerPlaylist, spotifyTrack, deezerTrack, mediaLink,
    spotifyTrackArtwork,
    spotifyProfilePlaylists, deezerProfilePlaylists,
  };
}

// The root user page carries the avatar; its /playlists subpage may not.
export const SPOTIFY_PROFILE_HEADER = `
  new Promise((resolve) => {
    const read = () => {
      const meta = (prop) => document.querySelector('meta[property="' + prop + '"]')?.getAttribute('content') || '';
      const header = document.querySelector('[data-testid="entity-header"], .main-entityHeader-container');
      const avatar = document.querySelector('img[data-testid="user-image"]')
        || header?.querySelector('figure img, img');
      let image = avatar?.currentSrc || avatar?.src || '';
      if (!image) {
        const figure = document.querySelector('[data-testid="user-image"]') || header?.querySelector('figure > div');
        const bg = figure ? getComputedStyle(figure).backgroundImage : '';
        if (bg?.startsWith('url(')) image = bg.slice(4, -1).replace(/["']/g, '').trim();
      }
      if (!image || image.startsWith('data:')) image = meta('og:image');
      const name = (header?.querySelector('h1')?.innerText || meta('og:title').split('|')[0]).trim();
      return { name, image };
    };
    let polls = 0;
    const first = read();
    if (first.image) { resolve(first); return; }
    const timer = setInterval(() => {
      const profile = read();
      if (profile.image || ++polls >= 20) { clearInterval(timer); resolve(profile); }
    }, 500);
  });
`;

// Injected into the Spotify profile page. Deliberately free of backslashes: this
// is a template literal, so every one would have to be doubled, and node --check
// cannot see in here to tell you when you got it wrong.
export const SPOTIFY_PROFILE_SCRAPE = `
  new Promise((resolve) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const shelf = () => document.querySelector('section[data-testid="component-shelf"][aria-label="Public Playlists"]');
    const anchors = () => Array.from((shelf() || document.body).querySelectorAll('a[href*="/playlist/"]'));

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
