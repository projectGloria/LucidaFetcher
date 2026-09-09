const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const UNITS = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };

// Where our own ffmpeg lives.
//
// yt-dlp shells out to ffmpeg for `extractAudio`, and it finds it on PATH -
// which is fine on a development machine and false on a clean one, so every
// audio extraction on a fresh install failed with nothing in the UI to say why.
// The binary ships with the app instead.
//
// An asar is a single file, so a real executable inside it cannot be spawned.
// electron-builder unpacks this one to app.asar.unpacked, and the path the
// module reports still points at the packed copy - swapping the segment is the
// documented way back to the file that actually exists on disk.
let ffmpegPath;
function ffmpegLocation() {
  if (ffmpegPath !== undefined) return ffmpegPath;
  try {
    const found = require('@ffmpeg-installer/ffmpeg').path;
    const unpacked = found.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
    // Only trust the swap if the file is really there; if it is not, the packed
    // path is no better, so fall through to PATH rather than handing yt-dlp a
    // location that cannot work.
    ffmpegPath = fs.existsSync(unpacked) ? unpacked : (fs.existsSync(found) ? found : null);
  } catch (err) {
    ffmpegPath = null;
  }
  return ffmpegPath;
}

/** yt-dlp options, plus `--ffmpeg-location` when we have one to give. */
function withFfmpeg(options) {
  const at = ffmpegLocation();
  return at ? { ...options, ffmpegLocation: at } : options;
}

// "[download]  10.0% of 5.00MiB at 1.00MiB/s" - the only progress yt-dlp gives
// on stdout. The byte total matters as much as the percentage: without it the
// UI can only draw a bar, and a 4MB fetch and a 400MB one look identical.
// youtube-dl-exec's child process is ALSO a promise, and it rejects on any
// non-zero exit. Every call here reads `close` itself - the exit code is data,
// not a failure, since yt-dlp exits 1 for a private set exactly as it does for a
// real error - so nothing ever attached a handler to that promise and Node
// reported an unhandled rejection. Swallow it at the source: the `close` handler
// is what decides the outcome.
function mute(proc) {
  if (proc && typeof proc.catch === 'function') proc.catch(() => {});
  return proc;
}

function parseProgress(text) {
  const m = /\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*([\d.]+)(B|KiB|MiB|GiB))?/.exec(text);
  if (!m) return null;
  const percent = parseFloat(m[1]);
  const total = m[2] ? Math.round(parseFloat(m[2]) * (UNITS[m[3]] || 1)) : 0;
  return { percent, total, received: total ? Math.round((total * percent) / 100) : 0 };
}

/**
 * Helper module to use yt-dlp via youtube-dl-exec.
 */
async function downloadYoutubeLink(url, savePath, onProgress, signal) {
  return new Promise((resolve, reject) => {
    try {
      const youtubedl = require('youtube-dl-exec');
      if (signal?.aborted) { reject(new Error("Download cancelled")); return; }
      // Download best audio, extract audio, convert to mp3 or keep best
      const proc = mute(youtubedl.exec(url, withFfmpeg({
        noPlaylist: true,
        newline: true,
        extractAudio: true,
        audioFormat: 'best', // ffmpeg does this, and ships with the app
        output: savePath,
        noCheckCertificates: true,
        noWarnings: true,
        // The referer is per-host, and asserting youtube.com while fetching a
        // SoundCloud upload is at best ignored and at worst a rejection.
        addHeader: ['user-agent:Mozilla/5.0']
      })));

      const abort = () => { proc.kill(); reject(new Error('Download cancelled')); };
      signal?.addEventListener('abort', abort, { once: true });
      proc.once('close', () => signal?.removeEventListener('abort', abort));
      let stderrTail = '';
      proc.stdout.on('data', (data) => {
        const p = parseProgress(data.toString());
        if (p && onProgress) onProgress(p.percent, p);
      });

      proc.stderr.on('data', (data) => {
        const text = data.toString();
        stderrTail = (stderrTail + text).slice(-800);
        console.warn('[yt-dlp stderr]', text);
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ ok: true, savePath });
        } else {
          // yt-dlp's last stderr line is the actual reason ("Video unavailable",
          // "Private track") - an exit code alone tells the user nothing and
          // ends up in the folder report as the only record of the failure.
          const why = stderrTail.split('\n').map((l) => l.trim())
            .filter((l) => /^ERROR/i.test(l)).slice(-1)[0];
          reject(new Error(why || `yt-dlp exited with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Fetch metadata (title, artist, thumbnail) using yt-dlp's dump-json.
 */
async function fetchMetadata(url) {
  return new Promise((resolve, reject) => {
    try {
      const youtubedl = require('youtube-dl-exec');
      youtubedl(url, {
        dumpJson: true,
        noCheckCertificates: true,
        noWarnings: true,
        addHeader: ['user-agent:Mozilla/5.0']
      }).then(output => {
        resolve({
          title: output.title || '',
          artist: output.uploader || output.artist || output.creator || '',
          thumbnail: output.thumbnail || ''
        });
      }).catch(err => {
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Search a yt-dlp-backed catalogue and return candidate uploads for a track.
 *
 * This is the last-resort source in the download chain, so it returns SEVERAL
 * candidates rather than one: the caller scores them against the wanted track
 * and may reject every one. A search always answers, and the answer is often a
 * "slowed + reverb" edit or an hour-long mix, so "first hit" is not a safe
 * choice to make down here.
 *
 * --flat-playlist keeps this to a single search request with no per-video
 * metadata fetches, which is what makes it cheap enough to sit in the chain.
 */
// YouTube throttles the search endpoint hard, and yt-dlp reports that by
// exiting 0 with EMPTY output rather than by failing - indistinguishable, at a
// glance, from an honest "nothing matched". Treating the two the same is how a
// throttled run silently records "not on YouTube" in the folder report for
// tracks that are plainly there. So searches are serialised (three workers
// hammering search is what triggers the throttle in the first place) and an
// empty result is reported as unavailable, not as an answer.
// One chain PER catalogue: YouTube's backoff must not stall a SoundCloud
// search, which is a different host with a different rate limit entirely.
const searchChains = new Map();

// 'ytsearch' | 'scsearch' - both take the same "<prefix><n>:<query>" form.
function searchMedia(prefix, query, limit = 5) {
  const chain = searchChains.get(prefix) || Promise.resolve();
  const run = () => searchMediaOnce(prefix, query, limit);
  const next = chain.then(run, run);
  // Keep the chain alive regardless of this call's fate, and space searches out.
  searchChains.set(prefix, next.then(() => new Promise((r) => setTimeout(r, 750)),
                                     () => new Promise((r) => setTimeout(r, 2000))));
  return next;
}

const searchYouTube = (query, limit) => searchMedia('ytsearch', query, limit);
const searchSoundCloud = (query, limit) => searchMedia('scsearch', query, limit);

async function searchMediaOnce(prefix, query, limit = 5) {
  return new Promise((resolve, reject) => {
    let youtubedl;
    try { youtubedl = require('youtube-dl-exec'); } catch (err) { reject(err); return; }

    const proc = mute(youtubedl.exec(`${prefix}${Math.max(1, Math.min(10, limit))}:${query}`, {
      dumpJson: true,
      flatPlaylist: true,
      noCheckCertificates: true,
      noWarnings: true,
      socketTimeout: 20,
      retries: 1,
      addHeader: ['user-agent:Mozilla/5.0']
    }));

    let out = '', errText = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { errText += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      // One JSON object per line, not a JSON array.
      const rows = out.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch (e) { return null; }
      }).filter(Boolean);

      // Exit 0 with nothing on stdout is throttling or a broken extractor, NOT
      // an empty catalogue: a genuine no-match still prints. yt-dlp gives no
      // other signal, so this shape is the only way to tell them apart.
      if (!rows.length) {
        const err = new Error(code === 0
          ? 'The search returned nothing (throttled or extractor failure)'
          : `yt-dlp search exited ${code}`);
        err.code = 'SEARCH_UNAVAILABLE';
        err.stderr = errText.trim().slice(0, 500);
        reject(err);
        return;
      }

      resolve(rows.map((r) => flatEntry(r, prefix)).filter((r) => r.url && r.title));
    });
  });
}

// A flat-playlist row, as the scorer wants it. SoundCloud rows name the
// uploader in `uploader`, YouTube's in `channel`; both may carry only an id,
// and only YouTube's id can be turned back into a URL - a SoundCloud entry
// without a permalink is unusable, so it is dropped rather than guessed at.
// SoundCloud's flat rows for a set carry NO title - only a permalink - so the
// slug is the only name available before anything else is fetched. It is a
// placeholder: `titleGuess` marks it so a caller that can afford one request per
// row (sources.mjs, via oEmbed) knows to replace it.
function slugTitle(url) {
  const slug = String(url || '').split('?')[0].split('#')[0].split('/').filter(Boolean).pop() || '';
  return slug.replace(/[-_]+/g, ' ').trim();
}

function flatEntry(r, prefix) {
  const permalink = r.webpage_url || r.original_url || r.url;
  const url = permalink && /^https?:/.test(permalink)
    ? permalink
    : (prefix === 'ytsearch' && r.id ? `https://www.youtube.com/watch?v=${r.id}` : null);
  // A row can itself be a container - a /albums or /sets listing page returns
  // one row per album, not per track. Saying so lets the UI open it instead of
  // queueing a "track" that is really nine of them. `playlist_count` is NOT a
  // signal here: yt-dlp stamps the PARENT listing's count onto every row.
  const isSet = r._type === 'playlist' || /Set|Playlist/i.test(String(r.ie_key || ''))
    || /soundcloud\.com\/[^/]+\/(?:sets\/|albums$|tracks$)/i.test(url || '');
  const guessed = !r.title && !!url;
  return {
    title: r.title || (guessed ? slugTitle(url) : ''),
    titleGuess: guessed,
    uploader: r.uploader || r.channel || r.uploader_id || '',
    durationSec: typeof r.duration === 'number' ? r.duration
      : (typeof r.duration_ms === 'number' ? Math.round(r.duration_ms / 1000) : null),
    thumbnail: r.thumbnail || (Array.isArray(r.thumbnails) && r.thumbnails.length
      ? r.thumbnails[r.thumbnails.length - 1].url : '') || '',
    isSet,
    url,
  };
}

/**
 * Everything behind one URL: a single track, or every track of a set/album.
 *
 * --flat-playlist keeps a 200-track set to ONE request - the per-track metadata
 * fetch it avoids is what made the obvious implementation take minutes. The
 * rows it returns are thinner (no exact duration on some extractors), and that
 * is the right trade here: the app only needs a title, an artist and a URL.
 */
function resolveMediaUrl(url) {
  return new Promise((resolve, reject) => {
    let youtubedl;
    try { youtubedl = require('youtube-dl-exec'); } catch (err) { reject(err); return; }

    const proc = mute(youtubedl.exec(url, {
      dumpJson: true,
      flatPlaylist: true,
      noCheckCertificates: true,
      noWarnings: true,
      addHeader: ['user-agent:Mozilla/5.0']
    }));

    let out = '', errText = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { errText += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      const rows = out.split('\n').map((l) => l.trim()).filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch (e) { return null; } })
        .filter(Boolean);
      if (!rows.length) {
        // A refusal from the extractor is not a bug to report as one: the set is
        // private, deleted, or blocked where this machine is.
        const last = errText.trim().split('\n').slice(-1)[0] || 'unknown error';
        const blocked = /HTTP Error (401|403|404)|Private|not available|removed/i.test(errText);
        const err = new Error(code === 0
          ? 'Nothing was found behind that link.'
          : blocked
            ? 'That one could not be opened - it is private, removed, or blocked in your region.'
            : `yt-dlp exited ${code}: ${last}`);
        err.stderr = errText.trim().slice(0, 500);
        reject(err);
        return;
      }

      // A playlist prints one row per entry with the playlist's own title on
      // every row; a single track prints one row that IS the track.
      const first = rows[0] || {};
      const isPlaylist = rows.length > 1 || first._type === 'playlist' || !!first.playlist_id;
      const prefix = /(soundcloud\.com|snd\.sc)/i.test(url) ? 'scsearch' : 'ytsearch';
      const entries = (first._type === 'playlist' && Array.isArray(first.entries) ? first.entries : rows)
        .map((r) => flatEntry(r, prefix))
        .filter((r) => r.url && r.title);

      resolve({
        kind: isPlaylist ? 'playlist' : 'track',
        title: (isPlaylist && (first.playlist_title || first.playlist || first.title)) || first.title || '',
        uploader: first.playlist_uploader || first.uploader || first.channel || '',
        thumbnail: entries[0] ? entries[0].thumbnail : '',
        entries,
      });
    });
  });
}

module.exports = {
  downloadYoutubeLink,
  fetchMetadata,
  searchYouTube,
  searchSoundCloud,
  resolveMediaUrl
};
