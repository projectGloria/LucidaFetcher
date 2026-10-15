// Canonical track identity for deduplication across playlists and services.
//
// Identity priority:
// 1. ISRC (best: identifies the exact recording across different streaming services)
// 2. Service-specific ID (e.g. spotify:trackId, deezer:trackId)
// 3. Normalized artist and title (fallback)
//
// Version markers ("Live", "Remastered", "feat.") are preserved so different
// versions remain distinct. Diacritics are stripped and Unicode letters/numbers
// from any script (Latin, Cyrillic, Kanji, Arabic, Hangul, etc.) are kept.

const norm = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1') // fold Latin accents; preserve other scripts
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]/gu, ''); // keep letters/numbers in ANY script

export function trackKey({ isrc, service, trackId, title, artist } = {}) {
  if (isrc) return `isrc:${String(isrc).toUpperCase().trim()}`;
  if (service && trackId) return `${String(service).toLowerCase().trim()}:${String(trackId).trim()}`;
  const a = norm(artist), t = norm(title);
  if (!a && !t) throw new Error('Cannot derive track key: no id, isrc, title or artist');
  return `na:${a}|${t}`;
}
