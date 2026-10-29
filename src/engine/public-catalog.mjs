export function classifyCatalogUrl(input) {
  let url;
  try { url = new URL(input); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  let match;
  if (['tidal.com', 'www.tidal.com', 'listen.tidal.com'].includes(url.hostname)) {
    match = /^\/(?:browse\/)?(track|album|playlist)\/([a-z0-9-]+)\/?$/i.exec(url.pathname);
    if (match) return { service: 'tidal', type: match[1], id: match[2], url: `https://tidal.com/browse/${match[1]}/${match[2]}` };
  }
  if (['qobuz.com', 'www.qobuz.com', 'play.qobuz.com', 'open.qobuz.com'].includes(url.hostname)) {
    match = /^\/(?:[a-z]{2}-[a-z]{2}\/)?(track|album|playlists?)\/(?:[^/]+\/)?([a-z0-9-]+)\/?$/i.exec(url.pathname);
    if (match) return { service: 'qobuz', type: match[1] === 'playlists' ? 'playlist' : match[1], id: match[2], url: url.href.split(/[?#]/)[0] };
  }
  return null;
}

export async function readCatalog(ref, { readPage, signal, maxPages = 50 }) {
  const tracks = [], seen = new Set();
  let cursor = null, meta, total = null, complete = false, reason;
  for (let page = 0; page < maxPages; page++) {
    signal?.throwIfAborted();
    let data;
    try { data = await readPage(ref, cursor, signal); }
    catch (error) {
      if (signal?.aborted || !tracks.length) throw error;
      reason = 'The next page could not be read.'; break;
    }
    if (!meta) meta = data;
    if (Number.isInteger(data.total) && data.total >= 0) total = data.total;
    const rows = data.tracks || [];
    tracks.push(...rows.filter(row => row.title && row.artist));
    if (!data.next) {
      complete = data.complete === true && (total == null || total === tracks.length);
      break;
    }
    if (!rows.length || seen.has(data.next)) { reason = 'Pagination stopped making progress.'; break; }
    seen.add(data.next); cursor = data.next;
  }
  if (!tracks.length) throw new Error('No public track metadata found. The link may be private, unavailable, or require sign-in.');
  return { ...meta, tracks, total, complete,
    warning: complete ? null : `Partial import: read ${tracks.length}${total == null ? '' : ` of ${total}`} tracks. ${reason || 'The public page did not confirm the complete track list.'}` };
}

// Injected into the public page. Keep all helpers inside this function.
export async function scrapePublicCatalog(ref, page = document, media = window.tidalMediaSessionMetadata, staticPage = false) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const seconds = value => {
    if (typeof value === 'number') return value;
    const iso = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(value || '');
    if (iso) return (+iso[1] || 0) * 3600 + (+iso[2] || 0) * 60 + (+iso[3] || 0);
    const parts = String(value || '').trim().split(':');
    return parts.every(p => /^\d+$/.test(p)) ? parts.reduce((n, p) => n * 60 + Number(p), 0) : null;
  };
  const names = value => (Array.isArray(value) ? value : [value]).filter(Boolean).map(v => v.name || v).join(', ');
  const image = value => typeof value === 'string' ? value : Array.isArray(value) ? image(value.at(-1)) : value?.url || '';
  let previous = -1, stable = 0, result;
  for (let attempt = 0; attempt < 30; attempt++) {
    const schemas = [];
    for (const node of page.querySelectorAll('script[type="application/ld+json"]')) {
      try { const data = JSON.parse(node.textContent); schemas.push(...(data['@graph'] || (Array.isArray(data) ? data : [data]))); } catch { /* Ignore unrelated malformed schema. */ }
    }
    const meta = schemas.find(s => ['MusicAlbum', 'MusicPlaylist', 'MusicRecording'].includes(s['@type'])) || {};
    const product = schemas.find(s => s['@type'] === 'Product') || {};
    const title = meta.name || page.querySelector('h1')?.textContent?.trim() || `${ref.service} ${ref.type}`;
    const cover = image(meta.image || product.image);
    const artist = names(meta.byArtist || meta.byArtist?.name || product.brand);
    const rows = [];
    if (ref.service === 'tidal' && media) {
      const metadata = media;
      const nodes = [...page.querySelectorAll('list-item[product-type="track"]')];
      const entries = nodes.length ? nodes.map(node => [node.getAttribute('product-id'), node]) : ref.type === 'track' ? [[ref.id, null]] : [];
      for (const [id, node] of entries) {
        const t = metadata[id];
        if (t) rows.push({ id, title: node?.querySelector('[slot="title"]')?.textContent?.trim() || t.title,
          artist: t.artist, album: t.album, image: t.artwork?.at(-1)?.src || '',
          durationSec: seconds(node?.querySelector('[slot="duration"]')?.textContent), isrc: t.isrc || null });
      }
    }
    const list = meta.track?.itemListElement || meta.track || (ref.type === 'track' && meta['@type'] === 'MusicRecording' ? [meta] : []);
    for (const entry of !rows.length && Array.isArray(list) ? list : []) {
      const t = entry.item || entry;
      rows.push({ id: String(ref.type === 'track' ? ref.id : t.identifier || t.url?.split('/').pop() || ''), title: t.name, artist: names(t.byArtist) || artist,
        album: ref.type === 'album' ? title : t.inAlbum?.name, image: image(t.image) || (ref.type === 'album' ? cover : ''),
        durationSec: seconds(t.duration), isrc: t.isrcCode || null });
    }
    if (!rows.length && ref.service === 'qobuz') {
      for (const node of page.querySelectorAll('[data-track][data-track-v2]')) {
        try {
          const t = JSON.parse(node.getAttribute('data-track-v2'));
          rows.push({ id: String(t.item_id), title: t.item_name, artist: t.item_brand,
            album: t.item_category, image: ref.type === 'album' ? cover : node.querySelector('img')?.src || '',
            durationSec: seconds(node.querySelector('.track__item--duration')?.textContent) });
        } catch { /* Never turn an incomplete row into a different recording. */ }
      }
    }
    if (!rows.length && ref.service === 'tidal') {
      for (const node of page.querySelectorAll('[data-test="tracklist-row"], [data-test="track-row"], [role="row"]')) {
        const track = node.querySelector('a[href*="/track/"]');
        const artists = [...node.querySelectorAll('a[href*="/artist/"]')].map(a => a.textContent.trim()).filter(Boolean);
        if (track && artists.length) rows.push({ id: track.href.split('/').pop(), title: track.textContent.trim(), artist: [...new Set(artists)].join(', '),
          album: ref.type === 'album' ? title : '', image: node.querySelector('img')?.src || (ref.type === 'album' ? cover : ''),
          durationSec: seconds(node.textContent.match(/\b\d+:\d{2}\b/)?.[0]) });
      }
    }
    const totalValue = Number(meta.numTracks || meta.track?.numberOfItems);
    const total = totalValue > 0 ? totalValue : ref.type === 'track' ? 1 : null;
    result = { name: title === `${ref.service} ${ref.type}` ? (ref.type === 'album' ? rows[0]?.album : ref.type === 'track' ? rows[0]?.title : null) || title : title,
      image: cover || (ref.type !== 'playlist' ? rows[0]?.image : ''), tracks: rows, total, complete: total != null && total === rows.length };
    stable = rows.length && rows.length === previous ? stable + 1 : 0;
    if (staticPage || result.complete || stable >= 3) return result;
    previous = rows.length; await sleep(500);
  }
  return result;
}

export function parseCatalogHtml(html, ref) {
  const page = new DOMParser().parseFromString(html, 'text/html');
  let media;
  for (const script of page.querySelectorAll('script')) {
    const match = script.textContent.match(/window\.tidalMediaSessionMetadata\s*=\s*(\{[^\n]*\})\s*;/);
    if (match) { try { media = JSON.parse(match[1]); } catch { /* Never evaluate page JavaScript. */ } }
  }
  return scrapePublicCatalog(ref, page, media, true);
}
