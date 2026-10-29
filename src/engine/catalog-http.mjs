import { classifyCatalogUrl } from './public-catalog.mjs';
import { resourceCache } from './resource-cache.mjs';

// Reads public catalog metadata only. The numeric web client ID is public;
// no account token, client secret, playback endpoint or credential is used.
export function createCatalogTransport({ fetch: request, readText }) {
  const text = async url => {
    let current = new URL(url);
    for (let hop = 0; hop < 4; hop++) {
      if (current.protocol !== 'https:' || current.username || current.password
          || !['www.qobuz.com', 'tidal.com', 'embed.tidal.com'].includes(current.hostname)) throw new Error('Invalid catalog redirect');
      const response = await request(current.href, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location) throw new Error('Invalid catalog redirect');
        current = new URL(location, current); continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Public catalog HTTP ${response.status}`); }
      return readText(response, current.hostname, 4 * 1024 * 1024);
    }
    throw new Error('Too many catalog redirects');
  };
  const publicClientId = resourceCache(async () => {
    const shop = await text('https://www.qobuz.com/us-en/shop');
    const albumPath = shop.match(/href=["'](\/us-en\/album\/[^"'#?]+)["']/)?.[1];
    if (!albumPath) throw new Error('Qobuz did not expose a public catalog entry');
    const album = await text(new URL(albumPath, 'https://www.qobuz.com').href);
    const id = album.match(/app_id=(\d+)/)?.[1];
    if (!id) throw new Error('Qobuz public metadata client is unavailable');
    return id;
  }, { concurrency: 1, maxEntries: 1, ttl: 3600000 });
  const read = resourceCache(async key => {
    const { url: input, cursor } = JSON.parse(key);
    const ref = classifyCatalogUrl(input);
    if (!ref) throw new Error('Unsupported public catalog link');
    if (ref.service === 'tidal') {
      if (cursor != null) throw new Error('Tidal embed does not expose pagination');
      const url = ref.type === 'track' ? ref.url : `https://embed.tidal.com/${ref.type}s/${ref.id}`;
      return { html: await text(url) };
    }
    try {
      const clientId = await publicClientId('qobuz');
      const offset = cursor == null ? 0 : Number(cursor);
      if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new Error('Invalid catalog offset');
      const url = new URL(`https://www.qobuz.com/api.json/0.2/${ref.type}/get`);
      url.searchParams.set('app_id', clientId); url.searchParams.set(`${ref.type}_id`, ref.id);
      url.searchParams.set('extra', 'tracks'); url.searchParams.set('limit', '100'); url.searchParams.set('offset', String(offset));
      const data = JSON.parse(await text(url.href));
      const rows = ref.type === 'track' ? [data] : data.tracks?.items || [];
      if (!rows.length || !rows[0]?.title) throw new Error('Qobuz metadata is unavailable in this catalog');
      const total = ref.type === 'track' ? 1 : data.tracks?.total ?? data.tracks_count;
      const image = data.image?.large || data.images300?.[0] || data.album?.image?.large || '';
      return { page: { name: data.title || data.name, image, total: Number.isInteger(total) ? total : null,
        next: Number.isInteger(total) && offset + rows.length < total ? String(offset + rows.length) : null,
        complete: Number.isInteger(total) && offset + rows.length === total,
        tracks: rows.map(track => ({ id: String(track.id), title: [track.title, track.version && `(${track.version})`].filter(Boolean).join(' '),
          artist: track.performer?.name || track.artist?.name || data.artist?.name,
          album: track.album?.title || (ref.type === 'album' ? data.title : ''),
          image: track.album?.image?.large || (ref.type === 'album' ? image : ''), durationSec: track.duration, isrc: track.isrc })) } };
    } catch (error) {
      if (cursor != null || ref.type === 'track') throw error;
      // The shop can expose an album that the regional streaming catalog cannot.
      // Its static track list is still useful, but completeness stays unconfirmed.
      const url = ref.url.startsWith('https://www.qobuz.com/') ? ref.url : `https://www.qobuz.com/us-en/${ref.type === 'playlist' ? 'playlists' : 'album'}/-/${ref.id}`;
      return { html: await text(url) };
    }
  }, { concurrency: 2, maxEntries: 30, ttl: 60000, sizeOf: value => JSON.stringify(value).length * 2 });
  return (url, cursor) => read(JSON.stringify({ url, cursor: cursor ?? null }));
}
