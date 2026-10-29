import { score, isAcceptable } from './matching.mjs';

// Qualification is shipped with the application, never inferred from a search
// response. A catalog that answers searches may still serve no lossless audio.
export const API_PROVIDERS = Object.freeze({
  'hifi-tidal': { label: 'HiFi Tidal API', backend: 'monochrome', baseUrl: 'https://api.monochrome.tf',
    qualified: false, reason: 'Not qualified: API host failed DNS resolution on 2026-10-28.' },
  'squid-qobuz': { label: 'Squid Qobuz API', backend: 'squid-qobuz', baseUrl: 'https://qobuz.squid.wtf',
    qualified: false, reason: 'Not qualified: API host failed DNS resolution; current response contract unverified (2026-10-28).' },
});

export function matchRecording(expected, candidates) {
  const normalized = value => String(value || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  const wanted = normalized(expected.isrc);
  const eligible = candidates.map(candidate => ({ ...candidate,
    exact: !!wanted && normalized(candidate.isrc) === wanted,
    score: score(expected, candidate.title, candidate.artist, candidate.durationSec) }))
    .filter(candidate => {
      if (wanted && candidate.isrc && normalized(candidate.isrc) !== wanted) return false;
      return isAcceptable(candidate.score);
    });
  eligible.sort((a, b) => Number(b.exact) - Number(a.exact) || b.score.a - a.score.a || b.score.t - a.score.t);
  return eligible[0] || null;
}

export function createProvider(id, { request, decodeBase64 = text => atob(text) }) {
  if (!API_PROVIDERS[id]) throw new Error('Unknown provider');
  const unwrap = response => {
    if (response.status === 429) throw Object.assign(new Error('Source rate limited'), { outcome: 'rate-limited', retryAfter: response.retryAfter });
    if (response.status === 403) throw Object.assign(new Error('Source access blocked'), { outcome: 'access-blocked' });
    if (response.status < 200 || response.status >= 300) throw new Error(`Provider HTTP ${response.status}`);
    return response.data?.data || response.data;
  };
  const get = async (operation, args, signal) => {
    signal?.throwIfAborted();
    const value = unwrap(await request(id, operation, args, signal));
    signal?.throwIfAborted(); return value;
  };
  return {
    async search(item, query, signal) {
      const data = await get('search', { query }, signal);
      const rows = data?.tracks?.items || data?.items || [];
      return rows.map(t => ({ id: String(t.id), title: t.title, artist: t.artist?.name || t.performer?.name,
        durationSec: t.duration, isrc: t.isrc, image: t.album?.image?.large || (t.album?.cover
          ? `https://resources.tidal.com/images/${t.album.cover.replaceAll('-', '/')}/1280x1280.jpg` : '') }));
    },
    async resolve(candidate, signal) {
      const data = await get('resolve', { id: candidate.id }, signal);
      let url;
      if (id === 'hifi-tidal') {
        if (!['LOSSLESS', 'HI_RES_LOSSLESS'].includes(data?.audioQuality) || data.manifestMimeType !== 'application/vnd.tidal.bts') throw new Error('No supported FLAC manifest');
        const manifest = JSON.parse(decodeBase64(data.manifest));
        if (manifest.encryptionType !== 'NONE' || manifest.mimeType !== 'audio/flac' || manifest.codecs !== 'flac') throw new Error('Not an unencrypted FLAC');
        url = manifest.urls?.[0];
      } else {
        // Squid is intentionally unqualified until this contract is observed.
        if (data?.mime_type !== 'audio/flac') throw new Error('Not FLAC');
        url = data.url;
      }
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Invalid media URL');
      return { url: parsed.href, artworkUrl: candidate.image, candidate };
    },
  };
}

export function providerRequestUrl(id, operation, args) {
  const provider = API_PROVIDERS[id];
  if (!provider || !['search', 'resolve'].includes(operation)) throw new Error('Invalid provider request');
  const url = new URL(id === 'hifi-tidal' ? (operation === 'search' ? '/search/' : '/track/') : '/api/get-music', provider.baseUrl);
  if (operation === 'search') {
    url.searchParams.set(id === 'hifi-tidal' ? 's' : 'query', String(args.query || '').slice(0, 500));
    if (id === 'squid-qobuz') url.searchParams.set('type', 'search');
  } else {
    if (!/^[a-z0-9-]+$/i.test(String(args.id))) throw new Error('Invalid track id');
    url.searchParams.set('id', args.id);
    if (id === 'hifi-tidal') url.searchParams.set('quality', 'LOSSLESS');
    else url.searchParams.set('type', 'track');
  }
  return url.href;
}
