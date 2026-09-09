// Choosing a YouTube result as the last-resort source for a track.
//
// This fallback existed before but was unreachable: item.ytFallbackUrl was only
// ever set when the user pasted a YouTube/SoundCloud link directly, so every
// track that arrived from a playlist reached the end of the chain with it unset
// and was abandoned. All five misses in the user's KAN run were of that kind.
//
// Reviving it needs a guard the old code never had. Lucida and Monochrome
// answer "no such track"; a YouTube search ALWAYS answers, so taking the first
// hit would turn a skip into a wrong file - a strictly worse outcome, and one
// the user would not notice until they played it. So the same scorer that gates
// the store cascades gates this too, which also buys the ALTERING protection
// for free: this genre's search results are thick with "slowed + reverb",
// "nightcore" and "sped up" re-uploads, and every one of them is refused
// against an expected title that carries no such marker.

import { score, isAcceptable, alteringMismatch, MIN_TITLE_SCORE } from './matching.mjs';

// Upload furniture that says nothing about which recording this is. Left in, it
// only drags precision down and muddles the ranking between real candidates.
const NOISE = /\b(official|officiel|video|videoclip|audio|lyrics?|lyric|visuali[sz]er|hd|hq|4k|full|stream|premiere|out\s+now|free\s+dl|free\s+download|music|mv)\b/gi;
const BRACKETED_NOISE = /[([][^)\]]*\b(?:official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|mv)\b[^)\]]*[)\]]/gi;

export function cleanYouTubeTitle(raw) {
  return String(raw || '')
    .replace(BRACKETED_NOISE, ' ')
    .replace(NOISE, ' ')
    .replace(/\s*[|·]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A YouTube title is usually "Artist - Title". The artist half would otherwise
// count as unmatched tokens against the expected title and depress precision,
// so offer both readings and keep whichever scores better.
function titleReadings(cleaned) {
  const out = [cleaned];
  const dash = cleaned.split(/\s+[-–—]\s+/);
  if (dash.length === 2) out.push(dash[1], dash[0]);
  return out.filter(Boolean);
}

const DEFAULT_MAX_DRIFT = 20; // seconds

/**
 * Rank YouTube candidates for an expected track.
 *
 * @param expected   { title, artist, durationSec? }
 * @param candidates [{ title, uploader, url, durationSec? }]
 * @returns ranked copies carrying { s, acceptable, reason }
 */
export function rankYouTube(expected, candidates, opts = {}) {
  const minTitleScore = opts.minTitleScore ?? MIN_TITLE_SCORE;
  const maxDrift = opts.maxDriftSec ?? DEFAULT_MAX_DRIFT;

  return candidates
    .map((c) => {
      const cleaned = cleanYouTubeTitle(c.title);
      // Score each reading against both the cleaned title and the uploader,
      // then keep the best - the artist may be in either field.
      const better = (s, b) => (s.a - b.a) || (s.t - b.t) || (s.p - b.p);
      let best = { t: 0, p: 0, a: 0 };
      for (const reading of titleReadings(cleaned)) {
        const s = score(expected, reading, `${c.uploader || ''} ${cleaned}`);
        if (better(s, best) > 0) best = s;
      }

      // Judged on the whole title, never a reading: a fragment must not be able
      // to launder a marker the full title declares.
      const altered = alteringMismatch(expected.title, cleaned);
      let acceptable = !altered && isAcceptable(best, minTitleScore);
      let reason = acceptable ? null : (altered ? 'different cut' : 'no confident match');

      // Duration is the one signal a title cannot fake, and it catches the two
      // things scoring cannot: an hour-long mix that happens to name the track,
      // and a 30-second teaser upload.
      if (acceptable && expected.durationSec && c.durationSec) {
        const drift = Math.abs(c.durationSec - expected.durationSec);
        if (drift > maxDrift) {
          acceptable = false;
          reason = `duration off by ${Math.round(drift)}s`;
        }
      }
      return { ...c, cleaned, s: best, acceptable, reason };
    })
    .sort((x, y) => (y.acceptable - x.acceptable) || (y.s.a - x.s.a) || (y.s.t - x.s.t) || (y.s.p - x.s.p));
}

export function pickYouTube(expected, candidates, opts = {}) {
  const ranked = rankYouTube(expected, candidates, opts);
  const chosen = ranked.find((c) => c.acceptable) || null;
  return { chosen, ranked };
}
