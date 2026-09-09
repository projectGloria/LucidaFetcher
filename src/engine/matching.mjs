// Candidate scoring for search results, shared by every cascade.
//
// This module is the single source of truth for "is this hit the track we asked
// for?". It has to run in two places: here (where it is unit tested) and INSIDE
// the scraped page's webview, which only accepts source text. The injectable
// form is generated from these very functions by injectableScorer(), so the
// rules that ship are the rules under test.
//
// WHY EVERY INJECTED FUNCTION TAKES ITS DEPENDENCIES AS ARGUMENTS.
// Generating source with Function.prototype.toString() is only safe if the
// function body contains no FREE identifiers. A bundler minifies this module,
// renaming module-scope names (FOLD -> Ae, norm -> xe, ...), and toString()
// then returns a body referring to those minified names - while the generated
// wrapper below declares them under their original names. The result is
// "Se is not defined" thrown inside the page, on every single search, in the
// built app only: dev and the test suite are unminified, so nothing catches it.
// Passing FOLD, STOP, ALTERING and the helper functions in as parameters means
// minification can rename only a function's own parameters and locals, which it
// does consistently within that function, and the generated code keeps working.
// Nothing below may reference a module-level binding.

export const MIN_TITLE_SCORE = 0.6; // share of expected title words a hit must contain

// Words that carry no identifying weight. "version"/"original"/"mix" belong
// here: on their own they name the ordinary release ("Original Mix", "album
// version"), not an altered cut, so "Fetish" and "Fetish (Original Mix)" must
// reduce to the same tokens. A genuinely different cut keeps its distinguishing
// word - "Club Mix" still carries 'club' - and 'remix' is a token of its own,
// gated separately by ALTERING.
export const STOP = ['the', 'and', 'feat', 'ft', 'with', 'for', 'from', 'version', 'original', 'mix'];

// Markers that mean a DIFFERENT recording rather than different wording of the
// same one. These must never be stopwords: while they were, "No Glory (Remix)"
// reduced to the single token "glory", so the remix, the instrumental and a
// slowed+reverb edit all scored 1.0 and the queue took whichever the site
// ranked first. A mismatch on any of these, in either direction, disqualifies.
export const ALTERING = ['remix', 'slowed', 'reverb', 'sped', 'instrumental', 'karaoke',
  'live', 'acoustic', 'bootleg', 'mashup', 'nightcore', 'cover'];

// Stroked/ligature letters have no NFD decomposition, so without an explicit
// fold they become spaces and shatter a word into unmatchable fragments
// ("Poloz" -> "po oz"). Playlist metadata is full of them.
export const FOLD = {
  'ł': 'l', 'ø': 'o', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'æ': 'ae', 'œ': 'oe',
  'ß': 'ss', 'ı': 'i', 'ħ': 'h', 'ŋ': 'n', 'ŧ': 't', 'ĸ': 'k'
};

// ---------------------------------------------------------------------------
// Injectable core. No free identifiers - see the note at the top of the file.
// ---------------------------------------------------------------------------

export function normWith(s, FOLD_) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9\s]/g, (c) => FOLD_[c] || ' ')
    .replace(/\s+/g, ' ').trim();
}

export function toksWith(s, FOLD_, STOP_, norm_) {
  return norm_(s, FOLD_).split(' ')
    .filter((t) => t.length >= 3 && STOP_.indexOf(t) === -1);
}

/**
 * @param K { FOLD, STOP, ALTERING, toks, norm }
 * @returns { t, p, a } - t is recall (share of expected title tokens present in
 *   the candidate), p is precision (share of the candidate's own tokens that
 *   were asked for, used only to break recall ties), a is 1 only when a whole
 *   credited artist name matched.
 */
export function scoreWith(expected, candTitle, candArtist, K) {
  const T = (s) => K.toks(s, K.FOLD, K.STOP, K.norm);
  const et = T(expected.title);
  const ct = T(candTitle);
  const ca = T(candArtist);
  if (et.length === 0) return { t: 0, p: 0, a: 0 };

  let hit = 0;
  for (const tk of et) if (ct.indexOf(tk) !== -1) hit++;
  let t = hit / et.length;

  // Recall alone cannot tell "Fetish" from "Money Fetish": every expected token
  // is present in both, so both score 1.0 and ties fall to whatever order the
  // site returned. Precision separates them (1.0 vs 0.5). It is deliberately a
  // ranking signal only, never a gate: legitimate hits carry extra tokens all
  // the time ("Stardust (Deluxe Edition)"), so rejecting on it would trade
  // wrong downloads for missing ones.
  let p = ct.length ? hit / ct.length : 0;

  // A version marker on one side but not the other means a different cut.
  for (const m of K.ALTERING) {
    if ((et.indexOf(m) !== -1) !== (ct.indexOf(m) !== -1)) { t = 0; p = 0; break; }
  }

  // Match a WHOLE credited name, not any one shared token - "Billy Joel" used
  // to satisfy a search for "Joel Nielsen" on the strength of "joel" alone.
  // Sources credit several artists comma-separated while the site often lists
  // one, so any single credit matching in full is enough. An artist can also
  // appear inside the candidate's title ("Track (Someone Remix)"), so check
  // both fields before giving up.
  const names = (expected.artist || '').split(/[,&]/).map((n) => T(n)).filter((n) => n.length);
  let a = names.length === 0 ? 1 : 0;
  for (const n of names) {
    if (n.every((tk) => ca.indexOf(tk) !== -1 || ct.indexOf(tk) !== -1)) { a = 1; break; }
  }
  return { t, p, a };
}

export function isAcceptableWith(s, minTitleScore) {
  return !!s && s.a === 1 && s.t >= minTitleScore;
}

// ---------------------------------------------------------------------------
// Convenience wrappers for use in this process. These MAY reference module
// scope, because they are never stringified.
// ---------------------------------------------------------------------------

const DEPS = { FOLD, STOP, ALTERING, toks: toksWith, norm: normWith };

export const norm = (s, FOLD_) => normWith(s, FOLD_ || FOLD);
export const toks = (s, FOLD_, STOP_) => toksWith(s, FOLD_ || FOLD, STOP_ || STOP, normWith);
export const score = (expected, candTitle, candArtist) =>
  scoreWith(expected, candTitle, candArtist, DEPS);
export const isAcceptable = (s, minTitleScore = MIN_TITLE_SCORE) =>
  isAcceptableWith(s, minTitleScore);

// True when one side is marked as an altered cut and the other is not.
//
// Exposed separately because callers that score several READINGS of one
// candidate title must judge this on the whole string. Splitting
// "Fetish - Obzkure [Nightcore]" on the dash yields the bare reading "Fetish",
// which carries no marker and sails through - so a fragment must never be
// allowed to launder a cut the full title declares.
export function alteringMismatch(expectedTitle, candidateTitle) {
  const et = toks(expectedTitle);
  const ct = toks(candidateTitle);
  return ALTERING.some((m) => (et.indexOf(m) !== -1) !== (ct.indexOf(m) !== -1));
}

// Rank candidates best-first. Unlike the old cascade - which sorted, took
// scored[0] and discarded the rest - callers get the whole ordered list so a
// candidate whose stream fails can be followed by the next one.
export function rankCandidates(expected, candidates, minTitleScore = MIN_TITLE_SCORE) {
  return candidates
    .map((c, i) => ({ ...c, index: i, s: score(expected, c.title, c.artist) }))
    .sort((x, y) => (y.s.a - x.s.a) || (y.s.t - x.s.t) || (y.s.p - x.s.p))
    .map((c) => ({ ...c, acceptable: isAcceptable(c.s, minTitleScore) }));
}

/**
 * The scorer as source text, for executeJavaScript inside a scraped page.
 *
 * The wrapper below is a literal - it is never minified - and every function it
 * splices in is free of outer references, so the two halves cannot drift apart
 * under a bundler. Exposes `score(title, artist)`, `isAcceptable(s, min)`,
 * `toks`, `norm`, `FOLD`, `STOP` and `MIN_TITLE_SCORE` to the cascade.
 */
export function injectableScorer(expected, minTitleScore = MIN_TITLE_SCORE) {
  return `
    const EXPECTED = ${JSON.stringify({ title: expected.title || '', artist: expected.artist || '' })};
    const MIN_TITLE_SCORE = ${minTitleScore};
    const FOLD = ${JSON.stringify(FOLD)};
    const STOP = ${JSON.stringify(STOP)};
    const ALTERING = ${JSON.stringify(ALTERING)};
    const norm = ${normWith.toString()};
    const toks = ${toksWith.toString()};
    const __scoreWith = ${scoreWith.toString()};
    const isAcceptable = ${isAcceptableWith.toString()};
    const __deps = { FOLD: FOLD, STOP: STOP, ALTERING: ALTERING, toks: toks, norm: norm };
    const score = (t, a) => __scoreWith(EXPECTED, t, a, __deps);
  `;
}
