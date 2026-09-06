const { ipcRenderer } = require('electron');

// --------------------------------------------------------------------------
// Logging. Everything goes to the main process, which owns the .jsonl file.
// `log()` must never throw and must never call console.warn/error itself, or
// the console mirror below would recurse.
// --------------------------------------------------------------------------
function log(evt, data = {}) {
  try { ipcRenderer.send('log', { evt, data }); } catch (e) { /* ignore */ }
}

['warn', 'error'].forEach((level) => {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    log('console.' + level, {
      msg: args.map((a) => {
        if (a instanceof Error) return a.message;
        if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return '[object]'; } }
        return String(a);
      }).join(' ')
    });
  };
});

window.addEventListener('error', (e) => log('error.uncaught', {
  message: e.message, source: e.filename, line: e.lineno,
  stack: (e.error && e.error.stack || '').split('\n').slice(0, 5).join(' | ')
}));
window.addEventListener('unhandledrejection', (e) => log('error.rejection', {
  message: String(e.reason && e.reason.message || e.reason)
}));

// Tabs
const tabs = document.querySelectorAll('.tab');
const views = document.querySelectorAll('.view');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    views.forEach(v => v.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.target).classList.add('active');
  });
});

// Settings
const pathDisplay = document.getElementById('download-path-display');
const browseBtn = document.getElementById('browse-btn');
const speedInput = document.getElementById('speed-limit');
const speedNote = document.getElementById('speed-note');
const scanChk = document.getElementById('scan-existing');
const clearCacheBtn = document.getElementById('clear-cache-btn');
const cacheNote = document.getElementById('cache-note');
const serviceListEl = document.getElementById('service-list');
const testServicesBtn = document.getElementById('test-services-btn');
const serviceNote = document.getElementById('service-note');

// Mirrors state/config.json, which the main process owns. Filled in by boot().
let config = { downloadPath: '', speedLimitKBps: 0, scanFolderForExisting: false,
               fallbackServices: null };

// Source service is distinct from Lucida, which is the transport. Keep all
// display details here so settings, queue rows and persisted data agree.
const SERVICE_DEFINITIONS = {
  qobuz: { label: 'Qobuz', icon: 'assets/services/qobuz.svg', lucidaSlug: 'qobuz' },
  tidal: { label: 'Tidal', icon: 'assets/services/tidal.svg', lucidaSlug: 'tidal' },
  deezer: { label: 'Deezer', icon: 'assets/services/deezer.svg', lucidaSlug: 'deezer' },
  soundcloud: { label: 'SoundCloud', icon: 'assets/services/soundcloud.svg', lucidaSlug: 'soundcloud' },
  amazon: { label: 'Amazon Music', icon: 'assets/services/amazon-music.svg', lucidaSlug: 'amazon' },
  yandex: { label: 'Yandex Music', icon: 'assets/services/yandex.svg', lucidaSlug: 'yandex' },
  spotify: { label: 'Spotify', icon: 'assets/services/spotify.svg', lucidaSlug: null }
};
const UNKNOWN_SERVICE = { label: 'Unknown source', icon: '', lucidaSlug: null };
const serviceHealth = {};

function normalizeService(value) {
  const text = String(value || '').toLowerCase().trim();
  const aliases = { 'amazon music': 'amazon', amazonmusic: 'amazon', 'yandex music': 'yandex' };
  return aliases[text] || (SERVICE_DEFINITIONS[text] ? text : null);
}
function serviceDefinition(service) { return SERVICE_DEFINITIONS[normalizeService(service)] || UNKNOWN_SERVICE; }
function serviceLabel(service) { return serviceDefinition(service).label; }
function serviceIcon(service) { return serviceDefinition(service).icon; }
function serviceFromUrl(url) {
  const source = String(url || '');
  const param = /[?&]service=([^&#]+)/i.exec(source);
  if (param) return normalizeService(decodeURIComponent(param[1]));
  return Object.keys(SERVICE_DEFINITIONS).find((sv) => source.toLowerCase().indexOf(sv) !== -1) || null;
}

function describeSpeed(kbps) {
  if (!kbps) return 'Unlimited.';
  return 'About ' + (kbps >= 1024 ? (kbps / 1024).toFixed(1) + ' MB/s' : kbps + ' KB/s') + ', averaged.';
}

if (speedInput) {
  speedInput.addEventListener('change', () => {
    const kbps = Math.max(0, parseInt(speedInput.value, 10) || 0);
    speedInput.value = kbps;
    config.speedLimitKBps = kbps;
    if (speedNote) speedNote.innerText = describeSpeed(kbps);
    ipcRenderer.send('set-config', { speedLimitKBps: kbps });
  });
}

if (scanChk) {
  scanChk.addEventListener('change', () => {
    config.scanFolderForExisting = scanChk.checked;
    ipcRenderer.send('set-config', { scanFolderForExisting: scanChk.checked });
  });
}

if (clearCacheBtn) {
  clearCacheBtn.addEventListener('click', async () => {
    const n = await ipcRenderer.invoke('cache-clear');
    if (cacheNote) cacheNote.innerText = `Cleared ${n} cached ${n === 1 ? 'entry' : 'entries'}.`;
  });
}

// ---------------------------------------------------------------------------
// Fallback service picker
//
// Which of Lucida's backends actually answer changes without notice - measured
// 2026-08-29, qobuz and amazon returned cards for a track certainly in every
// catalogue while soundcloud, tidal, deezer and yandex all returned the "uh-oh!"
// page, with and without a country param. That is a property of Lucida, not of
// this app, so the answer cannot live in a constant: the chain is a setting, and
// Test Services re-measures it in place rather than needing a code edit and a
// throwaway probe script.
// ---------------------------------------------------------------------------
function renderServiceChoices() {
  if (!serviceListEl) return;
  const ordered = FALLBACK_SERVICES.concat(ALL_SERVICES.filter((sv) => FALLBACK_SERVICES.indexOf(sv) === -1));
  serviceListEl.innerHTML = ordered.map((sv) => (
    '<div class="check-row" style="margin-bottom:4px;">'
    + `<input type="checkbox" id="svc-${sv}" ${FALLBACK_SERVICES.indexOf(sv) !== -1 ? 'checked' : ''}>`
    + `<label for="svc-${sv}" style="margin:0;color:#ddd;"><img class="service-inline-icon" src="${serviceIcon(sv)}" alt="" aria-hidden="true">${serviceLabel(sv)}`
    + `<span class="hint" id="svc-note-${sv}" style="margin-left:8px;"></span></label>`
    + `<button class="service-move" data-service="${sv}" data-direction="up" title="Move ${serviceLabel(sv)} up">↑</button>`
    + `<button class="service-move" data-service="${sv}" data-direction="down" title="Move ${serviceLabel(sv)} down">↓</button></div>`
  )).join('');
  ALL_SERVICES.forEach((sv) => {
    const box = document.getElementById('svc-' + sv);
    if (box) box.addEventListener('change', saveServiceChoices);
  });
  serviceListEl.querySelectorAll('.service-move').forEach((button) => button.addEventListener('click', () => {
    const service = button.dataset.service;
    const direction = button.dataset.direction;
    const order = FALLBACK_SERVICES.slice();
    const index = order.indexOf(service);
    if (index === -1) return;
    const other = direction === 'up' ? index - 1 : index + 1;
    if (other < 0 || other >= order.length) return;
    [order[index], order[other]] = [order[other], order[index]];
    config.fallbackServices = order;
    applyServiceConfig(order, 'settings-order');
    ipcRenderer.send('set-config', { fallbackServices: order });
    renderServiceChoices();
  }));
  describeChain();
}

function describeChain() {
  if (!serviceNote) return;
  const picked = Array.from(serviceListEl.querySelectorAll('input[id^="svc-"]'))
    .filter((box) => box.checked).map((box) => box.id.slice(4));
  serviceNote.innerText = picked.length
    ? 'Order: ' + FALLBACK_SERVICES.map(serviceLabel).join(' → ')
    : 'None picked - using the default (' + DEFAULT_FALLBACK_SERVICES.join(', ') + ').';
}

function saveServiceChoices() {
  const picked = ALL_SERVICES.filter((sv) => {
    const box = document.getElementById('svc-' + sv);
    return box && box.checked;
  });
  config.fallbackServices = picked;
  applyServiceConfig(picked, 'settings');
  ipcRenderer.send('set-config', { fallbackServices: picked });
  describeChain();
}

// A track that is on every store Lucida fronts, so a nil result is the store
// being down rather than the query being obscure.
const PROBE_QUERY = 'Get Lucky Daft Punk';

// Same two signals the download cascade reads: cards mean the backend answered,
// the "uh-oh!" page means it did not. Resolves as soon as either is certain.
const SERVICE_PROBE = `
  new Promise((resolve) => {
    let polls = 0;
    const tick = () => {
      const cards = document.querySelectorAll('.search-result').length;
      if (cards) { resolve({ cards: cards }); return; }
      const err = document.querySelector('.error h2, .error p');
      if (err && /uh-oh|no results/i.test(err.innerText || '')) {
        resolve({ cards: 0, error: (err.innerText || '').trim().slice(0, 40) });
        return;
      }
      if (++polls > 30) { resolve({ cards: 0, error: null }); return; }
      setTimeout(tick, 500);
    };
    tick();
  })
`;

async function testServices() {
  if (!testServicesBtn || testServicesBtn.disabled) return;
  testServicesBtn.disabled = true;
  const wasMode = scraperMode;
  scraperMode = 'service-probe'; // or the Lucida parser runs over every probe page
  const live = [];
  log('services.test.start', { services: ALL_SERVICES, query: PROBE_QUERY });
  try {
    for (const sv of ALL_SERVICES) {
      const noteEl = document.getElementById('svc-note-' + sv);
      if (noteEl) noteEl.innerText = '- testing...';
      if (serviceNote) serviceNote.innerText = `Testing ${sv}...`;
      const started = Date.now();
      let res;
      try {
        await loadScraperPage(lucidaSearchUrl(PROBE_QUERY, sv));
        res = await scraperView.executeJavaScript(SERVICE_PROBE);
      } catch (e) {
        res = { cards: 0, error: e.message };
      }
      const ms = Date.now() - started;
      const health = res.cards ? 'available' : (res.error && /uh-oh|backend|404/i.test(res.error) ? 'unavailable' : (res.error ? 'unknown' : 'timeout'));
      serviceHealth[sv] = { status: health, ms, checkedAt: new Date().toISOString() };
      if (res.cards) live.push(sv);
      if (noteEl) {
        noteEl.innerText = res.cards
          ? `- available (${res.cards} results, ${ms}ms)`
          : `- ${health}${res.error ? ' ("' + res.error + '")' : ''}`;
        noteEl.style.color = res.cards ? '#28a745' : '#c8a415';
      }
      log('service.health', { service: sv, status: health, cards: res.cards, error: res.error || null, ms, checkedAt: serviceHealth[sv].checkedAt });
    }
  } finally {
    scraperMode = wasMode;
    scraperView.removeAttribute('useragent');
    scraperView.src = 'about:blank';
    testServicesBtn.disabled = false;
  }
  log('services.test.result', { live });
  if (serviceNote) {
    serviceNote.innerText = live.length
      ? `Answered today: ${live.join(', ')}. Tick the ones to fall back to.`
      : 'No service answered - Lucida itself may be down.';
  }
}

if (testServicesBtn) testServicesBtn.addEventListener('click', testServices);

// The limiter works by pausing and resuming the transfer. A server that will not
// honour a range request restarts it instead, and the main process switches the
// limiter off rather than loop forever - say so, because the setting is now inert.
ipcRenderer.on('throttle-unsupported', () => {
  if (speedNote) speedNote.innerText = 'Limiter off: this server restarts the transfer instead of resuming it.';
  console.warn('[speed-limit] disabled - server will not resume a paused download');
});

ipcRenderer.invoke('get-log-path').then(p => {
  const el = document.getElementById('log-path-display');
  if (el) el.value = p;
});

browseBtn?.addEventListener('click', async () => {
  const newPath = await ipcRenderer.invoke('select-directory');
  if (newPath) {
    if (pathDisplay) pathDisplay.value = newPath;
    config.downloadPath = newPath;
  }
});

// Search
const searchInput = document.getElementById('search-input');
const resultsList = document.getElementById('results-list');
const statusText = document.getElementById('status-text');
const scraperView = document.getElementById('scraper-view');
const downloadView = document.getElementById('download-view');
const serviceSelect = document.getElementById('service-select'); // optional; falls back to qobuz
const searchModeSelect = document.getElementById('search-mode');
const profileServiceSelect = document.getElementById('profile-service');

// #scraper-view is shared between Lucida and the Spotify profile scrape, and its
// dom-ready handler below unconditionally injects the Lucida parser. Point it at
// Spotify without this and that parser runs against Spotify's DOM, finds nothing
// for the full 15s cascade, then resolves [] straight over the profile results.
let scraperMode = 'lucida';

if (searchModeSelect && profileServiceSelect) {
  const syncMode = () => {
    profileServiceSelect.style.display = searchModeSelect.value === 'user' ? '' : 'none';
  };
  searchModeSelect.addEventListener('change', syncMode);
  syncMode();
}

let isCurrentSearchALink = false;
let pendingScrapeKey = null; // cache key the next scrape result belongs to

// A cached result list carries the group id it was scraped with. Reuse that and a
// second download of the same album folds into the first album's progress bar, so
// every cache hit is re-stamped with a fresh one.
function freshGroupIds(results, prefix) {
  const seen = {};
  (results || []).forEach((r) => {
    if (!r || !r.group || !r.group.id) return;
    if (!seen[r.group.id]) seen[r.group.id] = prefix + '-' + Date.now() + '-' + Object.keys(seen).length;
    r.group = Object.assign({}, r.group, { id: seen[r.group.id] });
  });
  return results;
}

let searchHistory = [];
let historyIndex = -1;

async function performSearch(isHistoryAction = false) {
  if (!searchInput) return;
  const query = searchInput.value.trim();
  if (!query) return;

  if (!isHistoryAction) {
    if (historyIndex >= 0 && searchHistory[historyIndex] === query) {
      // noop
    } else {
      searchHistory = searchHistory.slice(0, historyIndex + 1);
      searchHistory.push(query);
      historyIndex++;
    }
  }

  resultsList.innerHTML = '';
  statusText.innerText = 'Loading...';
  const searchStartedAt = Date.now();

  // A profile lookup is the "user:" prefix, the explicit mode choice, or an
  // unmistakable profile URL. It has to be checked before anything else, and a bare
  // name can only mean "find this person" when one of those says so: "thesimulacrum"
  // is a perfectly good track query too, and guessing would break plain search.
  const activeScope = document.querySelector('.scope-option.active');
  const wantsProfile = USER_PREFIX.test(query)
    || (searchModeSelect && searchModeSelect.value === 'user')
    || (activeScope && activeScope.dataset.scope === 'profile')
    || /open\.spotify\.com\/user\//i.test(query)
    || /deezer\.com\/(?:[a-z]{2}\/)?profile\//i.test(query);
  if (wantsProfile) {
    await runProfileSearch(query, searchStartedAt);
    return;
  }

  const kind = query.includes('open.spotify.com') ? 'spotify' : (query.startsWith('http') ? 'url' : 'text');
  log('search.start', { query, kind });

  // A cache hit short-circuits everything below. It matters most for Spotify: the
  // track list is one embed fetch and then one MORE per track for its artwork, so
  // re-pasting a 130-track playlist is 131 round trips before any audio moves.
  const cacheKey = kind + ':' + query;
  pendingScrapeKey = null;
  const cached = await ipcRenderer.invoke('cache-get', cacheKey);
  if (cached && cached.length) {
    isCurrentSearchALink = kind !== 'text';
    log('search.result', { kind, tracks: cached.length, cached: true, ms: Date.now() - searchStartedAt });
    renderResults(freshGroupIds(cached, kind));
    statusText.innerText = `Found ${cached.length} results (cached).`;
    return;
  }

  if (kind === 'spotify') {
    isCurrentSearchALink = true;
    statusText.innerText = 'Extracting Spotify metadata via embed API...';
    // a pasted link is one playlist, so the per-track artwork fetches are affordable
    const res = await spotifyPlaylistTracks(query, {
      perTrackArtwork: true,
      onStatus: (t) => { statusText.innerText = t; }
    });
    if (res.error) {
      log('search.error', { kind: 'spotify', message: res.error });
      statusText.innerText = res.error;
      return;
    }
    ipcRenderer.send('cache-set', { key: cacheKey, value: res.results });
    log('search.result', {
      kind: 'spotify', playlist: res.name, tracks: res.results.length,
      ms: Date.now() - searchStartedAt
    });
    renderResults(res.results);
    return;
  }

  const isYouTube = /(youtube\.com|youtu\.be)/i.test(query);
  const isSoundCloud = /soundcloud\.com/i.test(query);
  if (isYouTube || isSoundCloud) {
    isCurrentSearchALink = true;
    statusText.innerText = 'Extracting track metadata via yt-dlp...';
    try {
      const meta = await ipcRenderer.invoke('yt-metadata', query);
      const title = meta.title || 'Unknown Title';
      const artist = meta.artist || 'Unknown Artist';
      
      const item = {
        link: query,
        image: meta.thumbnail,
        texts: [title, artist],
        ytFallbackUrl: query // Marks this item to fallback to yt-dlp
      };
      
      const service = serviceSelect ? serviceSelect.value : 'qobuz';
      item.link = `https://lucida.to/search?query=${encodeURIComponent(title + ' ' + artist)}&service=${service}&country=US`;
      
      ipcRenderer.send('cache-set', { key: cacheKey, value: [item] });
      renderResults([item]);
      statusText.innerText = `Found 1 result via ${isYouTube ? 'YouTube' : 'SoundCloud'}.`;
    } catch (err) {
      statusText.innerText = 'Could not extract metadata: ' + err.message;
    }
    return;
  }

  scraperMode = 'lucida';
  pendingScrapeKey = cacheKey; // what the scraper's dom-ready handler caches under
  if (query.startsWith('http')) {
    isCurrentSearchALink = true;
    scraperView.removeAttribute('useragent');
    scraperView.src = 'https://lucida.to/?url=' + encodeURIComponent(query);
  } else {
    isCurrentSearchALink = false;
    const service = serviceSelect ? serviceSelect.value : 'qobuz';
    scraperView.removeAttribute('useragent');
    scraperView.src = `https://lucida.to/search?query=${encodeURIComponent(query)}&service=${service}&country=US`;
  }
}

searchInput?.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') performSearch();
});

document.getElementById('btn-back')?.addEventListener('click', () => {
  if (historyIndex > 0) {
    historyIndex--;
    searchInput.value = searchHistory[historyIndex];
    performSearch(true);
  }
});

document.getElementById('btn-forward')?.addEventListener('click', () => {
  if (historyIndex < searchHistory.length - 1) {
    historyIndex++;
    searchInput.value = searchHistory[historyIndex];
    performSearch(true);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (document.activeElement !== searchInput && (window.innerHeight + window.scrollY >= document.body.offsetHeight - 50)) {
      searchInput.focus();
    }
  }
});

scraperView.addEventListener('dom-ready', async () => {
  if (!scraperView.src || scraperView.src === 'about:blank') return;
  if (scraperMode !== 'lucida') return; // a profile scrape drives this webview itself
  // Removed the '/search' check so direct URLs can be processed

  statusText.innerText = 'Parsing results...';

  const script = `
    new Promise((resolve) => {
      let attempts = 0;
      const interval = setInterval(() => {
        const cards = Array.from(document.querySelectorAll('.search-result'));
        const trackElements = Array.from(document.querySelectorAll('div[id^="track-"]'));
        
        if (cards.length > 0) {
          clearInterval(interval);
          
          const results = cards.map(card => {
            const titleEl = card.querySelector('.metadata h1');
            const artistEl = card.querySelector('.metadata h2');
            const linkEl = card.querySelector('.metadata a');
            const imgEl = card.querySelector('img');

            if (!titleEl || !linkEl) return null;

            const title = titleEl.innerText.trim();
            const artist = artistEl ? artistEl.innerText.trim() : '';
            const link = linkEl.href;
            
            const imgWrapper = imgEl ? imgEl.closest('a') : null;
            let image = imgWrapper && imgWrapper.href ? imgWrapper.href : (imgEl ? imgEl.src : '');
            if (image) image = image.replace(/(\\?|&)w=\\d+/g, '').replace(/(\\?|&)h=\\d+/g, '');

            return {
              link: link,
              image: image,
              texts: [title, artist].filter(Boolean)
            };
          }).filter(r => r !== null);

          const unique = [];
          const seen = new Set();
          for (const r of results) {
            if (!seen.has(r.link)) {
              seen.add(r.link);
              unique.push(r);
            }
          }
          resolve(unique);
        } else if (trackElements.length > 0) {
          clearInterval(interval);
          
          const albumTitle = document.querySelector('h1') ? document.querySelector('h1').innerText.trim() : 'Unknown Album';
          const artistEl = document.querySelector('h2');
          const albumArtist = artistEl ? artistEl.innerText.replace(/^by\\s+/i, '').trim() : '';
          const groupId = 'album-' + Date.now();
          
          const imgEl = document.querySelector('img.cover-right') || document.querySelector('img');
          const imgWrapper = imgEl ? imgEl.closest('a') : null;
          let image = imgWrapper && imgWrapper.href ? imgWrapper.href : (imgEl ? imgEl.src : '');
          if (image) image = image.replace(/(\\?|&)w=\\d+/g, '').replace(/(\\?|&)h=\\d+/g, '');
          
          const results = trackElements.map(trackDiv => {
             const p = trackDiv.querySelector('p');
             let title = p ? p.innerText.trim() : 'Unknown Track';
             title = title.replace(/^\\d+\\.\\s*/, ''); // Remove track number "1. "
             
             const btn = trackDiv.querySelector('.ico-button[data-url]');
             const rawLink = btn ? btn.getAttribute('data-url') : '';
             
             if (!rawLink) return null;
             
             const lucidaLink = window.location.origin + '/?url=' + encodeURIComponent(rawLink);
             
             return {
               link: lucidaLink,
               image: image,
               texts: [title, albumArtist].filter(Boolean),
               group: {
                  id: groupId,
                  name: albumTitle,
                  folderName: albumTitle.replace(/[<>:"/\\\\|?*]+/g, ''),
                  artworkUrl: image
               }
             };
          }).filter(r => r !== null);
          
          resolve(results);
        } else {
          // Check for Lucida error page (e.g. "uh-oh!")
          const errEl = document.querySelector('.error h2');
          if (errEl && errEl.innerText.toLowerCase().includes('uh-oh')) {
             clearInterval(interval);
             resolve([]);
             return;
          }
        }
        
        if (attempts > 30) {
          clearInterval(interval);
          resolve([]);
        }
        attempts++;
      }, 500);
    });
  `;

  try {
    const data = await scraperView.executeJavaScript(script);
    log('search.result', { kind: 'scrape', tracks: (data || []).length, url: scraperView.getURL() });
    if (pendingScrapeKey && data && data.length) {
      ipcRenderer.send('cache-set', { key: pendingScrapeKey, value: data });
      pendingScrapeKey = null;
    }
    renderResults(data);
  } catch (err) {
    log('search.error', { kind: 'scrape', message: err.message });
    statusText.innerText = 'Error parsing results.';
    console.error(err);
  }
});

// Artwork hover-to-zoom: a small wrapper around the cover <img> that shows a
// dark backdrop + zoom icon on hover, opens a full-size popup on click, and
// offers "Save artwork" on right-click (both on the thumb and the popup).
const ZOOM_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="11" y1="8" x2="11" y2="14"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>`;

function createArtworkThumb(imageUrl, title) {
  const thumb = document.createElement('div');
  thumb.className = 'result-thumb';

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = imageUrl || '';
  thumb.appendChild(img);

  if (imageUrl) {
    const overlay = document.createElement('div');
    overlay.className = 'thumb-zoom-overlay';
    overlay.innerHTML = ZOOM_ICON_SVG;
    overlay.title = 'View artwork';
    overlay.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openArtworkModal(imageUrl, title); };
    thumb.appendChild(overlay);

    thumb.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); showArtworkContextMenu(e.pageX, e.pageY, imageUrl, title); };
  }

  return thumb;
}

const artworkModal = document.getElementById('artwork-modal');
const artworkModalImg = document.getElementById('artwork-modal-img');
let artworkModalUrl = null;
let artworkModalTitle = null;

function openArtworkModal(imageUrl, title) {
  if (!artworkModal || !imageUrl) return;
  artworkModalUrl = imageUrl;
  artworkModalTitle = title || 'artwork';
  artworkModalImg.src = imageUrl;
  artworkModal.classList.remove('hidden');
}

function closeArtworkModal() {
  if (!artworkModal) return;
  artworkModal.classList.add('hidden');
  artworkModalImg.src = '';
  artworkModalUrl = null;
}

if (artworkModal) {
  artworkModal.addEventListener('click', (e) => {
    if (e.target === artworkModal || e.target.classList.contains('artwork-modal-backdrop')) closeArtworkModal();
  });
  const closeBtn = document.getElementById('artwork-modal-close');
  if (closeBtn) closeBtn.onclick = closeArtworkModal;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeArtworkModal(); });
  artworkModalImg.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (artworkModalUrl) showArtworkContextMenu(e.pageX, e.pageY, artworkModalUrl, artworkModalTitle);
  };
}

// Minimal custom right-click menu (Electron renderers get no native
// "Save image as..." menu for free) with a single "Save artwork" action
// that hands the URL to the main process to fetch and write to disk.
const artworkContextMenu = document.getElementById('artwork-context-menu');

function showArtworkContextMenu(x, y, imageUrl, title) {
  if (!artworkContextMenu) return;
  artworkContextMenu.style.left = x + 'px';
  artworkContextMenu.style.top = y + 'px';
  artworkContextMenu.classList.remove('hidden');
  artworkContextMenu.onclick = async (e) => {
    e.stopPropagation();
    hideArtworkContextMenu();
    const res = await ipcRenderer.invoke('download-artwork', { url: imageUrl, suggestedName: title });
    if (res && res.ok) {
      statusText.innerText = `Saved artwork to ${res.savePath}`;
    } else if (res && !res.cancelled) {
      statusText.innerText = 'Could not save artwork: ' + (res.error || 'unknown error');
    }
  };
}

function hideArtworkContextMenu() {
  if (artworkContextMenu) artworkContextMenu.classList.add('hidden');
}

document.addEventListener('click', hideArtworkContextMenu);
document.addEventListener('contextmenu', (e) => {
  if (artworkContextMenu && !artworkContextMenu.contains(e.target)) hideArtworkContextMenu();
});

function renderResults(data) {
  if (!data || data.length === 0) {
    statusText.innerText = 'No results found (Link may be invalid, or Lucida temporarily failed to fetch it).';
    return;
  }
  statusText.innerText = `Found ${data.length} results.`;
  resultsList.className = 'results-grid';
  resultsList.innerHTML = '';

  if (isCurrentSearchALink && data.length > 1) {
    const dlAllBtn = document.createElement('button');
    dlAllBtn.className = 'bulk-download-btn';
    dlAllBtn.innerText = 'Download All Tracks';
    dlAllBtn.style.marginBottom = '15px';
    dlAllBtn.style.padding = '10px 20px';
    dlAllBtn.style.background = '#28a745';
    dlAllBtn.style.fontWeight = 'bold';
    dlAllBtn.onclick = async () => {
      dlAllBtn.innerText = 'Queued All Tracks!';
      dlAllBtn.disabled = true;
      await enqueueAll(data);
      
      resultsList.style.transition = 'opacity 0.4s';
      resultsList.style.opacity = '0';
      
      setTimeout(() => {
          const dlTab = document.querySelector('.nav-item[data-tab="downloads"]');
          if (dlTab) dlTab.click();
          
          resultsList.innerHTML = '';
          searchInput.value = '';
          statusText.innerText = 'Queued playlist and switched to downloads.';
          resultsList.style.opacity = '1';
      }, 400);
    };
    resultsList.appendChild(dlAllBtn);
  }

  const rows = document.createDocumentFragment();
  data.forEach(item => {
    const row = document.createElement('div');
    row.className = 'result-item';

    const thumb = createArtworkThumb(item.image, item.texts[0] || 'artwork');
    row.appendChild(thumb);

    const info = document.createElement('div');
    info.className = 'result-info';

    const title = document.createElement('div');
    title.className = 'result-title';
    title.innerText = item.texts[0] || 'Unknown Title';
    info.appendChild(title);

    const desc = document.createElement('div');
    desc.className = 'result-texts';
    desc.innerText = item.texts.slice(1).join(' | ');
    info.appendChild(desc);

    row.appendChild(info);

    const downBtn = document.createElement('button');
    downBtn.className = 'download-btn';
    downBtn.innerText = 'Download';
    downBtn.onclick = async () => {
      downBtn.innerText = 'Starting...';
      downBtn.disabled = true;
      await enqueueAll([item]);
      downBtn.innerText = 'Added';
    };
    row.appendChild(downBtn);

    rows.appendChild(row);
  });
  resultsList.appendChild(rows);
}

let downloadQueue = [];
let isProcessingQueue = false;
let currentProcessingItem = null;
let downloadFileMap = {}; // Maps real file name to UI id
let lastHandledDownloadUrl = null; // webview url whose click-cascade already ran
let queuePaused = false; // set by the Pause button; see setQueuePaused()

// Identifies a track across runs, so the main process can answer "already got
// this one?". Deliberately not the Lucida url: the same track is reached through a
// different url on every fallback service.
function itemKey(folderName, title, artist) {
  return [folderName || '', title || '', artist || '']
    .map((s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim()).join('|');
}

// One round trip for the whole batch, then enqueue asynchronously - adding to UI
// instantly so the downloads count jumps and items appear immediately.
function enqueueAll(items) {
  const list = (items || []).filter(Boolean);
  
  const queueItems = list.map((item) => {
    const g = item.group;
    const folderName = g && g.folderName;
    const fullName = `${item.texts[0]} - ${item.texts[1] || ''}`.trim();
    const id = `item-${downloadIdCounter++}`;
    
    const profileId = (g && g.profileId) || null;
    const groupId = g && g.id;
    if (groupId) {
       if (!groupStats[groupId]) groupStats[groupId] = { total: 0, completed: 0, skipped: 0, downloading: false, sources: {} };
       groupStats[groupId].total++;
       if (profileId) {
         groupProfile[groupId] = profileId;
         const ps = profileStats[profileId];
         if (ps && ps.groups.indexOf(groupId) === -1) ps.groups.push(groupId);
       }
       updateGroupUI(groupId);
    }
    
    const originalService = serviceFromUrl(item.link) || 'qobuz';
    const queueItem = { id, url: item.link, name: fullName, folderName,
      groupArtwork: g && g.artworkUrl, image: item.image, groupId, groupName: g && g.name,
      profileId, profileName: (g && g.profileName) || null, profileService: (g && g.profileService) || null,
      title: item.texts[0] || '', artist: item.texts[1] || '', attempts: 0,
      fallbackIndex: -1, 
      originalService, attemptService: originalService, successfulService: null,
      triedServices: [], searchVariantIndex: 0,
      searchVariants: buildSearchVariants(item.texts[0], item.texts[1], item.album || ''),
      searchQuery: buildSearchQuery(item.texts[0], item.texts[1]),
      key: itemKey(folderName, item.texts[0], item.texts[1]) };
      
    log('queue.add', {
      id, name: fullName, title: queueItem.title, artist: queueItem.artist,
      searchQuery: queueItem.searchQuery, url: queueItem.url, groupId, groupName: g && g.name
    });
    return queueItem;
  });

  queueItems.forEach(qi => addDownloadToUI(qi));
  
  ipcRenderer.invoke('downloads-check', queueItems.map((qi) => ({
    key: qi.key,
    folderName: qi.folderName,
    title: qi.title
  }))).then(checks => {
    queueItems.forEach((qi, i) => {
      const existing = checks[i];
      if (existing && existing.done) {
        markAlreadyDownloaded(qi, existing);
      } else {
        downloadQueue.push(qi);
      }
    });
    updateQueueStatus();
    persistSoon();
    if (!isProcessingQueue) processNextInQueue();
  }).catch(e => {
    console.warn('[queue] existing-file check failed:', e.message);
    queueItems.forEach(qi => downloadQueue.push(qi));
    updateQueueStatus();
    persistSoon();
    if (!isProcessingQueue) processNextInQueue();
  });
}

function startDownload(item, groupId = null, groupName = null, folderName = null, artworkUrl = null, existing = null) {
  // Deprecated wrapper since enqueueAll now handles creation directly
}
const MIN_TITLE_SCORE = 0.6;  // share of expected title words a hit must contain
const MAX_START_ATTEMPTS = 3; // give up on a service after this many failed starts

// Services to re-search, in order, when a track cannot be got from the original
// link. Lucida fronts several stores and their catalogues differ, so a track that
// is missing (or matches the wrong song) on one is often present on the next.
// Valid slugs, from the service picker on lucida.to:
//   qobuz, tidal, soundcloud, deezer, amazon, yandex
// As of 2026-08-28 only qobuz and amazon actually answer: deezer, tidal and
// soundcloud return Lucida's "uh-oh!" error page for every query, including ones
// that certainly exist on those stores (tidal now 404s the search route outright).
// Deezer used to sit first here in the hope its backend would come back. It has
// not: re-probed 2026-08-28 with a track certainly in Deezer's catalogue, with no
// country param and with country=US and country=FR - all three returned "uh-oh!",
// while qobuz and amazon returned cards for the same query. Every fallback paid a
// ~5s round trip for it (95s across a 130-track run), so it is parked below rather
// than left in the chain. Re-verify before restoring any of these - see
// "Re-deriving selectors" in CLAUDE.md for the BrowserWindow probe recipe, and
// check that .search-result cards actually appear.
const ALL_SERVICES = ['qobuz', 'tidal', 'soundcloud', 'deezer', 'amazon', 'yandex'];

// The chain is a SETTING now, not a constant: which of Lucida's backends answer
// changes without notice, so routing around a dead one must not need a code edit.
// config.fallbackServices holds the user's picks (Settings -> Fallback Services);
// this is what ships, and what an empty or unrecognised setting falls back to.
//
// Only amazon is in the default because only amazon answers. Re-probed
// 2026-08-29 with "Get Lucky Daft Punk", a track in every catalogue, each slug
// with no country param and with country=US:
//   qobuz 60 cards, amazon 13 cards
//   soundcloud / tidal / deezer / yandex - 0 cards, Lucida's "uh-oh!" page
// qobuz is the store the original link already points at, so it stays out of the
// chain rather than being re-searched. The other four are left selectable, not
// deleted: the failure is in Lucida's backend and they have come back before.
// Test Services in Settings re-runs exactly this probe.
const DEFAULT_FALLBACK_SERVICES = ['amazon'];
let FALLBACK_SERVICES = DEFAULT_FALLBACK_SERVICES.slice();

// A dead service is cheap but not free: the injected cascade spots Lucida's
// "uh-oh!" page or an empty result scaffold and resolves in about a poll cycle,
// so an unavailable store costs seconds, not the full 30s cascade. That is why
// the default chain can afford to be optimistic and simply try everything.
function applyServiceConfig(list, source) {
  const picked = (Array.isArray(list) ? list : []).filter((sv) => ALL_SERVICES.indexOf(sv) !== -1);
  FALLBACK_SERVICES = picked.length ? picked : DEFAULT_FALLBACK_SERVICES.slice();
  log('session.config', {
    source: source || 'default', FALLBACK_SERVICES, MIN_TITLE_SCORE, MAX_START_ATTEMPTS,
    startTimeoutMs: 120000, cascadePolls: 60, emptyPollsBeforeNoResults: 16
  });
}

applyServiceConfig(null, 'default'); // re-run from config.json once boot() has it

// A version marker identifies the recording, so it has to survive into the query -
// but stripped of its brackets, and with only the primary artist alongside it.
// Measured against amazon on 2026-08-28 for Spotify's "No Glory (Remix)" by
// "Skan, Krale, LBLVNC", which the app had been skipping as unavailable:
//   "No Glory Skan, Krale, LBLVNC"      (old) -> 0 results
//   "No Glory (Remix) Skan, Krale, LBLVNC"    -> 0 results
//   "No Glory Skan"                           -> 0 results
//   "No Glory Remix Skan"               (new) -> 19 results, incl. the wanted cut
// Credit parentheticals ("(feat. X)") are noise and still come off; Spotify lists
// every remixer and collaborator, and passing the whole list narrows it to nothing.
const CREDIT_PAREN = /\s*[\(\[]\s*(?:feat\.?|featuring|with)\b[^\)\]]*[\)\]]/gi;

function buildSearchQuery(title, artist) {
  const cleanTitle = (title || '')
    .replace(CREDIT_PAREN, '')
    .replace(/[\(\)\[\]]/g, ' ') // keep the words, lose the brackets
    .replace(/\s+/g, ' ')
    .trim();
  const primary = (artist || '').split(/\s*[,&]\s*/)[0].trim();
  return `${cleanTitle} ${primary}`.trim();
}

function buildSearchVariants(title, artist, album) {
  const exactTitle = String(title || '').replace(CREDIT_PAREN, '').trim();
  const allArtists = String(artist || '').trim();
  const primary = allArtists.split(/\s*[,&]\s*/)[0].trim();
  const normalizedTitle = exactTitle.replace(/[\(\)\[\],.!?]+/g, ' ').replace(/\s+/g, ' ').trim();
  return [[exactTitle, allArtists].filter(Boolean).join(' '), [exactTitle, primary].filter(Boolean).join(' '),
    [normalizedTitle, primary].filter(Boolean).join(' '), [exactTitle, primary, album || ''].filter(Boolean).join(' ')]
    .filter((query, index, list) => query && list.indexOf(query) === index);
}

function lucidaSearchUrl(query, service) {
  return `https://lucida.to/search?query=${encodeURIComponent(query)}&service=${service}`;
}

// Which store the current attempt is aimed at, for status text.
function serviceOf(item) {
  if (item && item.attemptService) return normalizeService(item.attemptService) || item.attemptService;
  const i = item.fallbackIndex === undefined ? -1 : item.fallbackIndex;
  // item.service is the name the index MEANT when it was set. The chain is user
  // configurable and queue.json outlives a change to it, so a restored item's
  // index can point at a different store - or past the end of a shortened chain.
  if (i >= 0) return FALLBACK_SERVICES[i] || item.service || 'lucida';
  return serviceFromUrl(item.url) || item.originalService || 'lucida';
}

// Every service this track has been through, in order, with why each one failed.
// Feeds both the fallback chain (never try the same store twice) and the folder
// report, where it is the whole point: "which sources were tried".
function recordTried(item, service, outcome) {
  if (!item || !service) return;
  if (!Array.isArray(item.triedServices)) item.triedServices = Array.isArray(item.tried) ? item.tried.map((t) => t.service || t).filter(Boolean) : [];
  if (item.triedServices.indexOf(service) === -1) item.triedServices.push(service);
  if (!Array.isArray(item.tried)) item.tried = [];
  const prev = item.tried.filter((t) => t.service === service)[0];
  if (prev) { prev.outcome = outcome; return; }
  item.tried.push({ service, outcome, at: new Date().toISOString() });
}
// ---------------------------------------------------------------------------
// User profiles
//
// "Give me everything this person has made public." Neither service offers this
// the same way:
//
//   Spotify - there is no API without credentials (/api/token answers 400 for an
//     anonymous caller, verified 2026-08-29) and the profile page ships as an
//     empty shell: fetching the HTML yields zero playlist ids. So it has to be
//     RENDERED, which is what #scraper-view is for. Two things bite: Electron's
//     own user agent gets served the mobile "continue in the app" page, so a
//     desktop Chrome UA is set for the duration; and a consent dialog covers the
//     grid until it is dismissed.
//   Deezer - a plain public API, no key, and one call per playlist returns its
//     whole track list. But it sends no CORS header, so those requests go through
//     the main process ('http-json'), not fetch() in here.
//
// Both paths end in the same place: a list of {service, id, name, image, url}
// playlists, each expanded into tracks only when the user asks for it.
// ---------------------------------------------------------------------------
const SPOTIFY_DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  + ' (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// same shape the Spotify playlist path has always used for folder names
function sanitizeFolder(name) {
  return String(name || '').replace(/[<>:"/\\|?*]+/g, '').trim() || 'Playlist';
}

// "user:thesimulacrum" is the typed form of the mode dropdown. It is a prefix and
// not a guess, which is the whole point: a bare "thesimulacrum" has to stay a track
// query. An optional service token overrides the dropdown - "user:deezer:someone".
const USER_PREFIX = /^user:\s*/i;

function parseProfileInput(raw, service) {
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

// Drives #scraper-view directly rather than through its dom-ready handler, which
// belongs to the Lucida parser. Resolves once the page can be injected into.
function loadScraperPage(url, userAgent) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      scraperView.removeEventListener('dom-ready', onReady);
      scraperView.removeEventListener('did-fail-load', onFail);
      clearTimeout(timer);
      fn(arg);
    };
    const onReady = () => finish(resolve);
    const onFail = (e) => {
      if (e.isMainFrame) finish(reject, new Error(e.errorDescription || 'load failed'));
    };
    const timer = setTimeout(() => finish(reject, new Error('page load timed out')), 45000);
    scraperView.addEventListener('dom-ready', onReady);
    scraperView.addEventListener('did-fail-load', onFail);
    if (userAgent) scraperView.setAttribute('useragent', userAgent);
    else scraperView.removeAttribute('useragent');
    scraperView.src = url;
  });
}

// Injected into the profile page. Deliberately free of backslashes: this is a
// template literal, so every one would have to be doubled in the source, and
// node --check cannot see in here to tell you when you got it wrong.
const SPOTIFY_PROFILE_SCRAPE = `
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
        resolve({ outcome: shelf() ? 'empty' : 'no-shelf', items: [] });
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
        seen.set(id, { id: id, name: name || id, image: img ? img.src : '' });
      });
      resolve({ outcome: 'ok', items: Array.from(seen.values()) });
    })();
  });
`;

async function spotifyProfilePlaylists(user, onStatus) {
  const url = 'https://open.spotify.com/user/' + encodeURIComponent(user) + '/playlists';
  scraperMode = 'spotify-profile';
  try {
    if (onStatus) onStatus('Opening ' + user + ' on Spotify...');
    await loadScraperPage(url, SPOTIFY_DESKTOP_UA);
    if (onStatus) onStatus('Reading public playlists (the page has to render first)...');
    const res = await scraperView.executeJavaScript(SPOTIFY_PROFILE_SCRAPE);
    const items = (res && res.items) || [];
    return {
      outcome: (res && res.outcome) || 'error',
      user: user,
      playlists: items.map((pl) => ({
        service: 'spotify',
        id: pl.id,
        name: pl.name,
        image: pl.image,
        url: 'https://open.spotify.com/playlist/' + pl.id
      }))
    };
  } finally {
    // hand the webview back to the Lucida parser exactly as it was found
    scraperMode = 'lucida';
    scraperView.removeAttribute('useragent');
    scraperView.src = 'about:blank';
  }
}

function deezerJson(url) {
  return ipcRenderer.invoke('http-json', url);
}

// Deezer paginates through a 'next' link; follow it rather than guessing a limit.
async function deezerPaged(url, maxPages) {
  const out = [];
  let next = url;
  for (let i = 0; i < (maxPages || 20) && next; i++) {
    const page = await deezerJson(next);
    if (!page || !page.data || !page.data.length) break;
    out.push.apply(out, page.data);
    next = page.next || null;
  }
  return out;
}

async function deezerProfilePlaylists(user, onStatus) {
  let id = /^[0-9]+$/.test(user) ? user : null;
  let name = user;
  let avatar = '';
  if (!id) {
    if (onStatus) onStatus('Looking up "' + user + '" on Deezer...');
    const hits = await deezerJson('https://api.deezer.com/search/user?q=' + encodeURIComponent(user));
    const hit = ((hits && hits.data) || [])[0];
    if (!hit) return { outcome: 'no-user', user: user, playlists: [] };
    id = hit.id;
    name = hit.name || user;
    avatar = hit.picture_medium || hit.picture || '';
  } else {
    // unlike Spotify, Deezer publishes a real avatar and display name - one call
    try {
      const u = await deezerJson('https://api.deezer.com/user/' + id);
      if (u && !u.error) {
        name = u.name || name;
        avatar = u.picture_medium || u.picture || '';
      }
    } catch (e) { /* the playlists still work without it */ }
  }
  if (onStatus) onStatus('Fetching public playlists for ' + name + '...');
  const rows = await deezerPaged('https://api.deezer.com/user/' + id + '/playlists?limit=100');
  return {
    outcome: rows.length ? 'ok' : 'empty',
    user: name,
    avatar: avatar,
    playlists: rows.filter((r) => r && r.public !== false).map((r) => ({
      service: 'deezer',
      id: String(r.id),
      name: r.title || String(r.id),
      image: r.picture_medium || r.picture || '',
      tracks: r.nb_tracks,
      url: 'https://www.deezer.com/playlist/' + r.id
    }))
  };
}

// Every track, whatever it came from, reaches the queue as a Lucida *search* URL -
// the same shape the pasted-Spotify-link path has always produced.
function buildTrackResult(title, artist, image, group) {
  return {
    link: lucidaSearchUrl(buildSearchQuery(title, artist), 'qobuz'),
    image: image || group.artworkUrl || '',
    texts: [title, artist].filter(Boolean),
    group: group
  };
}

// Spotify's embed exposes no artwork on a playlist's trackList entries - only
// uri/title/subtitle/duration - so per-track covers cost one /embed/track fetch
// each and there is no batch endpoint without auth. Measured 2026-08-29 over a
// 22-track playlist: serial 6716ms, eight at a time 1057ms, all 22 resolved. The
// cap matters more than the speed - Promise.all over a whole trackList fires one
// request per track at once, and a profile does that for every playlist it holds.
const ART_POOL = 8;

function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  return Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  ).then(() => out);
}

// Per-track artwork costs one extra embed fetch EACH. That is affordable for a
// single pasted playlist and ruinous for a profile with a hundred of them, so it
// is opt-in; without it every track carries the playlist cover, which is what
// ends up in cover.jpg anyway.
async function spotifyPlaylistTracks(url, opts) {
  const o = opts || {};
  const status = o.onStatus || function () {};
  try {
    const embedUrl = url.replace('open.spotify.com/', 'open.spotify.com/embed/');
    const res = await fetch(embedUrl);
    const html = await res.text();
    const match = html.match(/<script id="__NEXT_DATA__".*?>([^<]+)<\/script>/);
    if (!match) return { error: 'Failed to extract tracks from Spotify link.' };

    const data = JSON.parse(match[1]);
    const entity = data.props?.pageProps?.state?.data?.entity;
    const trackList = entity?.trackList || [];
    if (!trackList.length) return { error: 'No tracks found on that Spotify link.' };

    const sources = entity?.coverArt?.sources;
    let defaultCover = o.cover || '';
    if (!defaultCover && sources && sources.length) {
      defaultCover = sources.reduce((a, b) => (a.width || 0) > (b.width || 0) ? a : b).url;
    }
    const playlistName = o.playlistName || entity?.name || 'Spotify Playlist';
    const groupId = 'spotify-' + Date.now();

    let images = trackList.map(() => defaultCover);
    if (o.perTrackArtwork) {
      status('Extracting track artworks...');
      images = await mapPool(trackList, ART_POOL, async (t) => {
        const trackId = String(t.uri || '').split(':').pop();
        try {
          const r = await fetch('https://open.spotify.com/embed/track/' + trackId);
          const h = await r.text();
          const m = h.match(/<script id="__NEXT_DATA__".*?>([^<]+)<\/script>/);
          if (m) {
            const d = JSON.parse(m[1]);
            const imgs = d.props?.pageProps?.state?.data?.entity?.visualIdentity?.image;
            if (imgs && imgs.length) {
              const best = imgs.reduce((a, b) => (a.width || 0) > (b.width || 0) ? a : b);
              return best.url || defaultCover;
            }
            return defaultCover;
          }
        } catch (e) { /* fall back to the playlist cover */ }
        return defaultCover;
      });
    }

    const group = {
      id: groupId,
      name: playlistName,
      folderName: sanitizeFolder(playlistName),
      artworkUrl: defaultCover
    };
    return {
      results: trackList.map((t, i) => buildTrackResult(t.title, t.subtitle || '', images[i], group)),
      name: playlistName
    };
  } catch (e) {
    return { error: 'Error fetching Spotify metadata: ' + e.message };
  }
}

async function deezerPlaylistTracks(pl) {
  try {
    const rows = await deezerPaged('https://api.deezer.com/playlist/' + pl.id + '/tracks?limit=200');
    if (!rows.length) return { error: 'No tracks on that Deezer playlist.' };
    const group = {
      id: 'deezer-' + Date.now(),
      name: pl.name,
      folderName: sanitizeFolder(pl.name),
      artworkUrl: pl.image || ''
    };
    return {
      results: rows.map((t) => buildTrackResult(t.title || '', t.artist?.name || '', pl.image, group)),
      name: pl.name
    };
  } catch (e) {
    return { error: 'Deezer playlist fetch failed: ' + e.message };
  }
}

async function runProfileSearch(rawQuery, startedAt) {
  const service = profileServiceSelect ? profileServiceSelect.value : 'spotify';
  const parsed = parseProfileInput(rawQuery, service);
  if (!parsed) {
    statusText.innerText = 'That link is not a user profile.';
    return;
  }
  log('profile.start', { service: parsed.service, user: parsed.user });

  // Keyed per service: the same name is a different person on each.
  const cacheKey = 'profile:' + parsed.service + ':' + parsed.user.toLowerCase();
  const cached = await ipcRenderer.invoke('cache-get', cacheKey);
  if (cached && cached.length) {
    log('profile.result', {
      service: parsed.service, user: parsed.user, playlists: cached.length,
      cached: true, ms: Date.now() - startedAt
    });
    renderPlaylists(cached, parsed);
    return;
  }

  const onStatus = (t) => { statusText.innerText = t; };
  let res;
  try {
    res = parsed.service === 'deezer'
      ? await deezerProfilePlaylists(parsed.user, onStatus)
      : await spotifyProfilePlaylists(parsed.user, onStatus);
  } catch (e) {
    log('profile.error', { service: parsed.service, user: parsed.user, message: e.message });
    statusText.innerText = 'Could not read that profile: ' + e.message;
    return;
  }

  const playlists = res.playlists || [];
  log('profile.result', {
    service: parsed.service, user: parsed.user, outcome: res.outcome,
    playlists: playlists.length, ms: Date.now() - startedAt
  });
  if (!playlists.length) {
    statusText.innerText = res.outcome === 'no-user'
      ? 'No such user on ' + parsed.service + '.'
      : 'No public playlists found for "' + parsed.user + '" on ' + parsed.service + '.';
    return;
  }
  ipcRenderer.send('cache-set', { key: cacheKey, value: playlists });
  renderPlaylists(playlists, Object.assign({}, parsed, {
    user: res.user || parsed.user, avatar: res.avatar || ''
  }));
}

// One playlist -> its tracks -> the queue. Cached under its own key prefix so it
// never collides with the pasted-link path, whose entries carry per-track artwork.
async function queuePlaylist(pl, setLabel, profile) {
  const label = setLabel || function () {};
  label('Fetching...');
  const key = 'playlist:' + pl.service + ':' + pl.url;
  let results = await ipcRenderer.invoke('cache-get', key);
  if (results && results.length) {
    results = freshGroupIds(results, pl.service);
  } else {
    const res = pl.service === 'deezer'
      ? await deezerPlaylistTracks(pl)
      : await spotifyPlaylistTracks(pl.url, {
          playlistName: pl.name, cover: pl.image, perTrackArtwork: true
        });
    if (res.error || !res.results || !res.results.length) {
      log('playlist.expand', {
        service: pl.service, id: pl.id, name: pl.name, error: res.error || 'empty'
      });
      label('Failed');
      // the row was created up front by beginProfile; say so rather than leaving
      // it reading "Waiting to expand..." for the rest of the run
      if (pl.groupId && groupStats[pl.groupId]) {
        groupStats[pl.groupId].failed = true;
        updateGroupUI(pl.groupId);
      }
      return 0;
    }
    results = res.results;
    ipcRenderer.send('cache-set', { key: key, value: results });
  }
  // removed while its tracks were being fetched - drop them on the floor
  if (pl.groupId && removedGroups[pl.groupId]) {
    label('Removed');
    return 0;
  }
  // beginProfile already made a group (and a row) for this playlist, so the ids
  // minted during the scrape have to give way to it.
  if (pl.groupId || profile) {
    results.forEach((r) => {
      r.group = Object.assign({}, r.group, {
        id: pl.groupId || (r.group && r.group.id),
        profileId: profile ? profile.id : undefined,
        profileName: profile ? profile.name : undefined,
        profileService: profile ? profile.service : undefined
      });
    });
  }
  log('playlist.expand', {
    service: pl.service, id: pl.id, name: pl.name, tracks: results.length,
    profile: profile ? profile.id : undefined
  });
  await enqueueAll(results);
  label('Queued ' + results.length);
  return results.length;
}

// Strictly one at a time: each is an embed fetch (Spotify) or an API call
// (Deezer), and the download queue is serial anyway, so there is nothing to win
// by firing a hundred of them at once.
async function queueAllPlaylists(playlists, btn, parsed) {
  btn.disabled = true;
  const profileId = parsed ? beginProfile(parsed, playlists) : null;
  const profile = profileId
    ? { id: profileId, name: parsed.user, service: parsed.service }
    : null;

  // Switch across straight away: the profile and all of its playlists are already
  // on the Downloads tab, and they fill in underneath as each one is read. The
  // first playlist starts downloading while the hundredth is still being fetched.
  const dlTab = document.querySelector('.nav-item[data-tab="downloads"]');
  if (dlTab) dlTab.click();

  let tracks = 0;
  const epoch = expansionEpoch;
  for (let i = 0; i < playlists.length; i++) {
    if (epoch !== expansionEpoch) { // the profile was removed under us
      btn.innerText = 'Stopped';
      statusText.innerText = 'Stopped queueing - the profile was removed.';
      return;
    }
    const pl = playlists[i];
    btn.innerText = 'Queueing ' + (i + 1) + '/' + playlists.length + '...';
    statusText.innerText = 'Expanding "' + pl.name + '" (' + (i + 1) + ' of ' + playlists.length + ')...';
    tracks += await queuePlaylist(pl, playlistRowLabels[pl.service + ':' + pl.id], profile);
    if (profileId) {
      profileStats[profileId].expanded = i + 1;
      updateProfileUI(profileId);
    }
  }
  btn.innerText = 'Queued ' + tracks + ' tracks';
  statusText.innerText = 'Queued ' + tracks + ' tracks from ' + playlists.length + ' playlists.';
}

let playlistRowLabels = {};

function renderPlaylists(playlists, parsed) {
  isCurrentSearchALink = false;
  playlistRowLabels = {};
  statusText.innerText = `Found ${playlists.length} public playlist(s) for ${parsed.user}.`;
  resultsList.className = 'results-grid';
  resultsList.innerHTML = '';

  const headerContainer = document.createElement('div');
  headerContainer.className = 'bulk-download-btn';
  headerContainer.style.display = 'flex';
  headerContainer.style.gap = '10px';
  headerContainer.style.marginBottom = '15px';

  const allBtn = document.createElement('button');
  allBtn.className = 'btn';
  allBtn.innerText = 'Download All ' + playlists.length + ' Playlists';
  allBtn.style.padding = '10px 20px';
  allBtn.style.background = '#28a745';
  allBtn.style.color = '#fff';
  allBtn.style.fontWeight = 'bold';
  allBtn.onclick = () => queueAllPlaylists(playlists, allBtn, parsed);
  headerContainer.appendChild(allBtn);

  if (parsed && parsed.user) {
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn';
    saveBtn.innerText = 'Save Profile';
    saveBtn.style.padding = '10px 20px';
    saveBtn.onclick = async () => {
      const p = (await ipcRenderer.invoke('profiles-get')) || [];
      const url = parsed.service === 'deezer' ? `deezer.com/profile/${parsed.user}` : `open.spotify.com/user/${parsed.user}`;
      if (!p.some((item) => item.user && item.user.toLowerCase() === parsed.user.toLowerCase() && item.service === parsed.service)) {
        p.push({ user: parsed.user, service: parsed.service, url });
        ipcRenderer.send('profiles-save', p);
        if (typeof renderSavedProfiles === 'function') renderSavedProfiles();
      }
      saveBtn.innerText = 'Saved!';
      saveBtn.disabled = true;
    };
    headerContainer.appendChild(saveBtn);
  }

  resultsList.appendChild(headerContainer);

  const rows = document.createDocumentFragment();
  playlists.forEach((pl) => {
    const row = document.createElement('div');
    row.className = 'result-item';

    const thumb = createArtworkThumb(pl.image, pl.name);
    row.appendChild(thumb);

    const info = document.createElement('div');
    info.className = 'result-info';

    const title = document.createElement('div');
    title.className = 'result-title';
    title.innerText = pl.name;
    info.appendChild(title);

    const desc = document.createElement('div');
    desc.className = 'result-texts';
    desc.innerText = [pl.service, pl.tracks ? pl.tracks + ' tracks' : null].filter(Boolean).join(' | ');
    info.appendChild(desc);

    row.appendChild(info);

    const btn = document.createElement('button');
    btn.className = 'download-btn';
    btn.innerText = 'Queue tracks';
    const label = (t) => { btn.innerText = t; };
    playlistRowLabels[pl.service + ':' + pl.id] = label;
    btn.onclick = async () => {
      btn.disabled = true;
      await queuePlaylist(pl, label);
    };
    row.appendChild(btn);

    rows.appendChild(row);
  });

  resultsList.appendChild(rows);
}

let downloadIdCounter = 0;
let groupStats = {};
// groupId -> Set<id>. Mirrors group membership of activeDownloads so a group's
// rows/removal don't require scanning every item in the whole queue. Maintained
// alongside every site that adds/removes an item from activeDownloads.
let groupItems = {};
// groupId -> Set<id> already rendered as a row, so renderGroupRows doesn't need
// a document.getElementById probe per candidate to skip already-rendered ones.
let renderedGroupRowIds = {};

function updateQueueStatus() {
  // Intentionally a no-op: the per-row/queue progress UI already shows how
  // many tracks are pending, so a duplicate "Pending in download queue: N"
  // status line was removed.
}

// Per-group rAF coalescing, same pattern as scheduleProfileUI - keyed by groupId
// so multiple groups each still get their own coalesced update rather than
// sharing one frame slot.
let groupUpdateFrames = {}; // groupId -> requestAnimationFrame id
let pendingGroupUpdates = {}; // groupId -> {currentItem, stateText}

function updateGroupUI(groupId, currentItem = null, stateText = null) {
  if (!groupId || !groupStats[groupId]) return;
  pendingGroupUpdates[groupId] = { currentItem, stateText };
  if (groupUpdateFrames[groupId]) return;
  groupUpdateFrames[groupId] = requestAnimationFrame(() => {
    delete groupUpdateFrames[groupId];
    const args = pendingGroupUpdates[groupId];
    delete pendingGroupUpdates[groupId];
    if (args) renderGroupUI(groupId, args.currentItem, args.stateText);
  });
}

function renderGroupUI(groupId, currentItem = null, stateText = null) {
  if (!groupId || !groupStats[groupId]) return;
  const stats = groupStats[groupId];
  const textEl = document.getElementById('group-text-' + groupId);
  const fillEl = document.getElementById('group-fill-' + groupId);
  const statusEl = document.getElementById('group-status-' + groupId);
  const imgEl = document.getElementById('group-img-' + groupId);
  const sourceSummary = () => Object.keys(stats.sources || {}).map((sv) => serviceLabel(sv) + ' ' + stats.sources[sv]).join(' • ');
  
  if (textEl && fillEl && stats.total === 0) {
    // pre-created by beginProfile and not fetched yet: settled/0 is NaN
    textEl.innerText = stats.failed ? '\u2014' : '0/?';
    fillEl.style.width = '0%';
    if (statusEl) statusEl.innerHTML = stats.failed
      ? '<span style="color:#c8a415;">Nothing to download</span>'
      : '<span style="color:#888;">Waiting to expand...</span>';
  } else if (textEl && fillEl) {
    const settled = stats.completed + (stats.skipped || 0);
    textEl.innerText = `${settled}/${stats.total}` + (stats.skipped ? ` (${stats.skipped} skipped)` : '');
    const pct = Math.round((settled / stats.total) * 100);
    fillEl.style.width = pct + '%';
    if (pct === 100) {
      fillEl.style.background = stats.skipped ? '#c8a415' : '#28a745';
      if (statusEl) {
        // Built as one assignment rather than a base innerHTML write followed by
        // an innerHTML += - the += was a read-modify-write that reparsed the
        // whole subtree just to append one span.
        const base = stats.skipped
          ? `<strong style="color:#c8a415;">Finished &middot; ${stats.skipped} skipped</strong>`
          : '<strong style="color:#28a745;">Completed</strong>';
        const src = sourceSummary();
        statusEl.innerHTML = base + (src ? '<span class="hint"> &middot; Sources: ' + src + '</span>' : '');
      }
      if (imgEl) imgEl.style.opacity = '0'; // Hide layered track art when done
    } else if (settled > 0 || stats.downloading) {
      if (statusEl) {
         const verb = stateText || 'Downloading';
         if (currentItem) {
            statusEl.innerHTML = `<strong style="color:#007bff;">${verb}</strong> (${settled + 1}/${stats.total}) &middot; ${currentItem.name}`;
            if (imgEl && currentItem.image) {
                imgEl.src = currentItem.image;
                imgEl.style.opacity = '1'; // Show track artwork next to album artwork
                imgEl.style.left = '55px'; // Slide it out slightly for the visual layered effect
            }
         } else {
            statusEl.innerHTML = `<strong style="color:#007bff;">${verb}</strong> (${settled + 1}/${stats.total})...`;
         }
      }
    }
  }

  // A profile's counters are summed from its playlists rather than kept in
  // parallel, so every existing groupStats mutation reaches it through here.
  if (groupProfile[groupId]) scheduleProfileUI(groupProfile[groupId]);
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// The "No active downloads." placeholder is a direct child <p>. Match only that:
// a bare querySelector('p') also hits any <p> inside a group that already exists,
// and wiping innerHTML then throws away the containers built so far.
function clearDownloadsPlaceholder() {
  if (downloadsList.classList.contains('empty')) {
    downloadsList.classList.remove('empty');
    downloadsList.innerHTML = '';
  } else if (downloadsList.querySelector(':scope > p')) {
    downloadsList.innerHTML = '';
  }
}

// Created on demand by addDownloadToUI, and up front by beginProfile - a profile
// lists every playlist before any of them has been fetched, so a container has to
// be able to exist with no rows and a total of 0 in it.
function ensureGroupContainer(groupId, groupName, artwork, profileId) {
  let groupContainer = document.getElementById('group-' + groupId);
  if (groupContainer) return groupContainer;
  clearDownloadsPlaceholder();

  groupContainer = document.createElement('details');
  groupContainer.id = 'group-' + groupId;
  groupContainer.style.background = '#1a1a1a';
  groupContainer.style.padding = '10px';
  groupContainer.style.marginBottom = '15px';
  groupContainer.style.borderRadius = '8px';
  groupContainer.style.border = '1px solid #333';

  const summary = document.createElement('summary');
  summary.style.display = 'flex';
  summary.style.alignItems = 'center';
  summary.style.padding = '10px';
  summary.style.background = '#222';
  summary.style.borderRadius = '8px';
  summary.style.cursor = 'pointer';
  summary.style.userSelect = 'none';
  summary.style.marginBottom = '10px';

  summary.innerHTML = `
          <div style="display: flex; align-items: center; margin-right: 15px; position: relative; width: 105px; height: 60px;">
             <img src="${esc(artwork || '')}" style="width: 60px; height: 60px; border-radius: 6px; object-fit: cover; position: absolute; left: 0; z-index: 2; box-shadow: 3px 0 6px rgba(0,0,0,0.6);">
             <img id="group-img-${groupId}" src="" style="width: 50px; height: 50px; border-radius: 6px; object-fit: cover; position: absolute; left: 45px; top: 5px; z-index: 1; opacity: 0; transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);">
          </div>
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: bold; font-size: 1.1em; margin-bottom: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${esc(groupName)}</div>
            <div id="group-status-${groupId}" style="font-size: 0.85em; color: #aaa; margin-bottom: 8px;">Queued...</div>
            <div class="progress-bg" style="height: 6px; width: 100%; border-radius: 3px; background: #444; margin: 0;">
               <div class="progress-fill" id="group-fill-${groupId}" style="width: 0%; height: 100%; background: #007bff; border-radius: 3px; transition: width 0.3s;"></div>
            </div>
          </div>
          <div id="group-text-${groupId}" style="margin-left: 15px; font-size: 0.9em; font-weight: bold; color: #fff;">${(groupStats[groupId] && groupStats[groupId].total) || 0}</div>
       `;

  // appended as a node, not into innerHTML: a button inside <summary> toggles the
  // <details> unless the click is stopped here
  const rmBtn = document.createElement('button');
  rmBtn.className = 'sum-remove';
  rmBtn.innerText = 'Remove';
  rmBtn.title = 'Remove this playlist from the queue';
  rmBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); removeGroup(groupId, groupName); };
  summary.appendChild(rmBtn);

  groupContainer.appendChild(summary);
  const tracks = document.createElement('div');
  tracks.className = 'group-download-items';
  groupContainer.appendChild(tracks);
  groupContainer.addEventListener('toggle', () => {
    if (groupContainer.open) renderGroupRows(groupId);
  });
  const host = profileId ? ensureProfileContainer(profileId) : null;
  if (host) host.appendChild(groupContainer);
  else downloadsList.prepend(groupContainer);
  return groupContainer;
}


// --------------------------------------------------------------------------
// Profiles - a third level above the playlist groups
//
//   <details> profile        (thesimulacrum)
//     <details> playlist     (one per public playlist, created up front)
//       track rows
//
// Playlists are listed before they are fetched, so the profile can be expanded
// and browsed while expansion is still running. A group with total 0 is one that
// has not been reached yet, which is why updateGroupUI has to tolerate it.
// --------------------------------------------------------------------------
let profileStats = {}; // profileId -> { name, service, artwork, groups[], expected, expanded }
let groupProfile = {}; // groupId -> profileId
let profileUpdateFrame = null;
const pendingProfileUpdates = new Set();

function scheduleProfileUI(profileId) {
  if (!profileId) return;
  pendingProfileUpdates.add(profileId);
  if (profileUpdateFrame !== null) return;
  profileUpdateFrame = requestAnimationFrame(() => {
    profileUpdateFrame = null;
    const ids = Array.from(pendingProfileUpdates);
    pendingProfileUpdates.clear();
    ids.forEach(updateProfileUI);
  });
}

function ensureProfileContainer(profileId) {
  let el = document.getElementById('profile-' + profileId);
  if (el) return el;
  clearDownloadsPlaceholder();
  const p = profileStats[profileId] || { name: 'Profile', service: '', artwork: '', expected: 0 };

  el = document.createElement('details');
  el.id = 'profile-' + profileId;
  el.style.background = '#141414';
  el.style.padding = '10px';
  el.style.marginBottom = '18px';
  el.style.borderRadius = '10px';
  el.style.border = '1px solid #3a3a3a';

  const summary = document.createElement('summary');
  summary.style.display = 'flex';
  summary.style.alignItems = 'center';
  summary.style.padding = '12px';
  summary.style.background = '#202020';
  summary.style.borderRadius = '8px';
  summary.style.cursor = 'pointer';
  summary.style.userSelect = 'none';
  summary.style.marginBottom = '10px';
  const initial = String(p.name || '?').trim().charAt(0).toUpperCase() || '?';
  const avatar = p.artwork
    ? `<img src="${esc(p.artwork)}" style="flex-shrink: 0; width: 64px; height: 64px; border-radius: 50%; object-fit: cover; margin-right: 15px; border: 2px solid #444;">`
    : `<div style="flex-shrink: 0; width: 64px; height: 64px; border-radius: 50%; margin-right: 15px; border: 2px solid #444; background: #2b2b2b; color: #8a8a8a; display: flex; align-items: center; justify-content: center; font-size: 28px; font-weight: bold;">${esc(initial)}</div>`;
  summary.innerHTML = `
     ${avatar}
     <div style="flex: 1; min-width: 0;">
       <div style="font-weight: bold; font-size: 1.2em; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${esc(p.name)}</div>
       <div style="font-size: 0.75em; color: #777; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">${esc(p.service || '')} profile &middot; ${p.expected} playlist${p.expected === 1 ? '' : 's'}</div>
       <div id="profile-status-${profileId}" style="font-size: 0.85em; color: #aaa; margin-bottom: 8px;">Queued...</div>
       <div class="progress-bg" style="height: 6px; width: 100%; border-radius: 3px; background: #444; margin: 0;">
          <div class="progress-fill" id="profile-fill-${profileId}" style="width: 0%; height: 100%; background: #007bff; border-radius: 3px; transition: width 0.3s;"></div>
       </div>
     </div>
     <div id="profile-text-${profileId}" style="margin-left: 15px; font-size: 0.9em; font-weight: bold; color: #fff;">0/0</div>
  `;
  const rmBtn = document.createElement('button');
  rmBtn.className = 'sum-remove';
  rmBtn.innerText = 'Remove';
  rmBtn.title = 'Remove this whole profile from the queue';
  rmBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); removeProfile(profileId); };
  summary.appendChild(rmBtn);

  el.appendChild(summary);
  downloadsList.prepend(el);
  return el;
}

function updateProfileUI(profileId) {
  const p = profileStats[profileId];
  if (!p) return;
  let total = 0, completed = 0, skipped = 0;
  p.groups.forEach((gid) => {
    const st = groupStats[gid];
    if (!st) return;
    total += st.total;
    completed += st.completed;
    skipped += st.skipped || 0;
  });
  const settled = completed + skipped;
  const textEl = document.getElementById('profile-text-' + profileId);
  const fillEl = document.getElementById('profile-fill-' + profileId);
  const statusEl = document.getElementById('profile-status-' + profileId);

  if (textEl) textEl.innerText = settled + '/' + total + (skipped ? ' (' + skipped + ' skipped)' : '');
  if (fillEl) {
    fillEl.style.width = (total ? Math.round((settled / total) * 100) : 0) + '%';
    if (total > 0 && settled >= total && p.expanded >= p.expected) {
      fillEl.style.background = skipped ? '#c8a415' : '#28a745';
    }
  }
  if (!statusEl) return;
  const pls = ' &middot; ' + Math.min(p.expanded, p.expected) + '/' + p.expected + ' playlists read';
  if (p.expanded < p.expected) {
    statusEl.innerHTML = '<strong style="color:#007bff;">Expanding</strong>' + pls;
  } else if (total > 0 && settled >= total) {
    statusEl.innerHTML = skipped
      ? '<strong style="color:#c8a415;">Finished &middot; ' + skipped + ' skipped</strong>'
      : '<strong style="color:#28a745;">Completed</strong>';
  } else if (total === 0) {
    statusEl.innerHTML = '<span style="color:#c8a415;">No downloadable tracks found</span>';
  } else {
    statusEl.innerHTML = '<strong style="color:#007bff;">Downloading</strong> (' + (settled + 1) + '/' + total + ')' + pls;
  }
}

// Registers the profile and one group per playlist BEFORE anything is fetched, so
// pressing Download All puts the profile in the queue immediately and every
// playlist is there to expand while the tracks are still being read.
function beginProfile(parsed, playlists) {
  const profileId = 'profile-' + Date.now();
  profileStats[profileId] = {
    name: parsed.user,
    service: parsed.service,
    // NOT a playlist cover. Spotify serves no avatar on either profile route
    // (checked 2026-08-29: zero ab677657 images on /user/<id> and /user/<id>/
    // playlists), so borrowing the first playlist's art just made the profile
    // look like one of its own playlists. Empty falls back to a monogram.
    artwork: parsed.avatar || '',
    groups: [],
    expected: playlists.length,
    expanded: 0
  };
  ensureProfileContainer(profileId);
  playlists.forEach((pl, i) => {
    const gid = profileId + '-pl-' + i;
    pl.groupId = gid;
    groupStats[gid] = { total: 0, completed: 0, skipped: 0, downloading: false, sources: {} };
    groupProfile[gid] = profileId;
    profileStats[profileId].groups.push(gid);
    ensureGroupContainer(gid, pl.name, pl.image, profileId);
    updateGroupUI(gid);
  });
  log('profile.queue', {
    id: profileId, user: parsed.user, service: parsed.service, playlists: playlists.length
  });
  return profileId;
}

function createDownloadRow(itemData) {
  const { id, name, groupArtwork, image, folderName } = itemData;
  const item = document.createElement('div');
  item.className = 'download-item';
  item.id = 'dl-' + id;

  const imgEl = document.createElement('img');
  imgEl.className = 'cover-img';
  imgEl.loading = 'lazy';
  imgEl.decoding = 'async';
  imgEl.src = image || groupArtwork || '';

  const overlayEl = document.createElement('div');
  overlayEl.className = 'cover-overlay hidden';
  overlayEl.id = 'dl-overlay-' + id;
  overlayEl.title = 'Fetching...';
  const spinnerEl = document.createElement('div');
  spinnerEl.className = 'cover-spinner';
  overlayEl.appendChild(spinnerEl);

  const coverContainer = document.createElement('div');
  coverContainer.className = 'cover-container';
  coverContainer.appendChild(imgEl);
  coverContainer.appendChild(overlayEl);

  const infoEl = document.createElement('div');
  infoEl.className = 'download-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'download-name';
  nameEl.innerText = name;

  const bgEl = document.createElement('div');
  bgEl.className = 'progress-bg';
  const fillEl = document.createElement('div');
  fillEl.className = 'progress-fill';
  fillEl.id = 'dl-fill-' + id;
  bgEl.appendChild(fillEl);

  const textEl = document.createElement('div');
  textEl.className = 'progress-text';
  textEl.id = 'dl-text-' + id;
  textEl.innerText = 'Queued...';
  
  infoEl.appendChild(nameEl);
  infoEl.appendChild(bgEl);
  infoEl.appendChild(textEl);

  const rmEl = document.createElement('button');
  rmEl.className = 'row-remove';
  rmEl.title = 'Remove this track from the queue';
  rmEl.innerText = '\u00d7';
  rmEl.onclick = (e) => { e.preventDefault(); e.stopPropagation(); removeQueueItems([id], 'row'); };

  const folderBtn = document.createElement('button');
  folderBtn.className = 'row-open-folder';
  folderBtn.id = 'dl-folder-' + id;
  folderBtn.title = 'Open the folder this track downloads into';
  folderBtn.innerText = 'Open folder';
  folderBtn.onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rec = activeDownloads[id];
    const res = await ipcRenderer.invoke('open-item-folder', {
      savePath: rec && rec.savePath,
      folderName: (rec && rec.item.folderName) || folderName
    });
    if (res && !res.ok) statusText.innerText = res.error || 'Could not open that folder.';
  };

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.appendChild(rmEl);
  actions.appendChild(folderBtn);

  item.appendChild(coverContainer);
  item.appendChild(infoEl);
  item.appendChild(actions);
  const rec = activeDownloads[id];
  if (rec) applyDownloadRowState(item, rec.status);
  updateCoverOverlay(id);
  return item;
}

// Black backdrop + spinner directly over the artwork while the app is
// actively searching Lucida for the track - once it starts downloading (or
// settles as completed/skipped), the overlay comes off and the artwork is
// fully visible.
function updateCoverOverlay(id, state) {
  const overlay = document.getElementById('dl-overlay-' + id);
  if (!overlay) return;
  if (state === 'searching') {
    overlay.classList.remove('hidden');
  } else {
    overlay.classList.add('hidden');
  }
}

function applyDownloadRowState(row, status) {
  const fillEl = row.querySelector('.progress-fill');
  const textEl = row.querySelector('.progress-text');
  if (!fillEl || !textEl) return;
  const id = row.id.replace('dl-', '');
  const queueItem = activeDownloads[id] && activeDownloads[id].item;
  if (status === 'completed') {
    fillEl.style.width = '100%';
    fillEl.style.background = '#28a745';
    textEl.innerText = 'Completed' + sizeSourceSuffix(id, queueItem);
  } else if (status === 'skipped') {
    fillEl.style.width = '100%';
    fillEl.style.background = '#c8a415';
    textEl.innerText = 'Skipped';
  } else if (status === 'downloading') {
    textEl.innerText = 'Downloading...';
  }
  updateCoverOverlay(id, status);
}

// " • 8.4 MB • Qobuz" style suffix used once a size and/or source are known.
function sizeSourceSuffix(id, queueItem) {
  const parts = [];
  const rec = activeDownloads[id];
  if (rec && rec.bytes) parts.push(`${(rec.bytes / 1024 / 1024).toFixed(2)} MB`);
  const service = queueItem && (queueItem.successfulService || queueItem.attemptService);
  if (service) parts.push(serviceLabel(service));
  return parts.length ? ' • ' + parts.join(' • ') : '';
}


function renderGroupRows(groupId) {
  const group = document.getElementById('group-' + groupId);
  if (!group || !group.open) return;
  const host = group.querySelector('.group-download-items');
  if (!host) return;
  const ids = groupItems[groupId];
  if (!ids || !ids.size) return;
  const rendered = renderedGroupRowIds[groupId] || (renderedGroupRowIds[groupId] = new Set());
  const rows = document.createDocumentFragment();
  ids.forEach((id) => {
    if (rendered.has(id)) return;
    const rec = activeDownloads[id];
    if (!rec) return;
    rendered.add(id);
    rows.appendChild(createDownloadRow(rec.item));
  });
  host.appendChild(rows);
}

function addDownloadToUI(itemData) {
  const { id, groupId, groupName, groupArtwork, image, profileId } = itemData;
  clearDownloadsPlaceholder();
  activeDownloads[id] = { status: 'queued', item: itemData };
  persistedDownloadIds.add(id);
  if (groupId) (groupItems[groupId] || (groupItems[groupId] = new Set())).add(id);
  updateBadge();

  if (document.getElementById('dl-' + id)) return; // Already exists (retry)
  if (groupId) {
    const group = ensureGroupContainer(groupId, groupName, groupArtwork || image, profileId);
    if (group.open) {
      group.querySelector('.group-download-items').appendChild(createDownloadRow(itemData));
      (renderedGroupRowIds[groupId] || (renderedGroupRowIds[groupId] = new Set())).add(id);
    }
  } else {
    downloadsList.prepend(createDownloadRow(itemData));
  }
}

// Settle an item without downloading it. It counts as completed for the group bar,
// so a part-finished album reads 10/10 rather than stalling at 4/10.
function markAlreadyDownloaded(queueItem, existing) {
  if (!activeDownloads[queueItem.id]) return;
  activeDownloads[queueItem.id].status = 'completed';
  activeDownloads[queueItem.id].savePath = existing.savePath || null;
  activeDownloads[queueItem.id].bytes = existing.bytes || null;
  queueItem.successfulService = normalizeService(existing.service) || null;
  persistedDownloadIds.delete(queueItem.id);
  const fillEl = document.getElementById('dl-fill-' + queueItem.id);
  const textEl = document.getElementById('dl-text-' + queueItem.id);
  if (fillEl) { fillEl.style.width = '100%'; fillEl.style.background = '#28a745'; }
  if (textEl) textEl.innerText = 'Already downloaded' + sizeSourceSuffix(queueItem.id, queueItem);
  updateCoverOverlay(queueItem.id, 'completed');
  if (queueItem.groupId && groupStats[queueItem.groupId]) {
    groupStats[queueItem.groupId].completed++;
    const sources = groupStats[queueItem.groupId].sources || (groupStats[queueItem.groupId].sources = {});
    const source = queueItem.successfulService || 'unknown';
    sources[source] = (sources[source] || 0) + 1;
    updateGroupUI(queueItem.groupId);
  }
  log('skip.exists', {
    id: queueItem.id, name: queueItem.name,
    file: existing.file, via: existing.via
  });
  // Backfills folders downloaded before this app wrote reports, and keeps a
  // restored session from dropping tracks out of an existing one.
  ipcRenderer.send('report-track', {
    folderName: queueItem.folderName,
    section: 'downloaded',
    entry: {
      title: queueItem.title, artist: queueItem.artist,
      group: queueItem.groupName || null,
      service: queueItem.successfulService || null,
      file: existing.file || null,
      via: 'existing-' + (existing.via || 'manifest')
    }
  });
}

let downloadTimeout;
let clearStartListener = null; // removes the in-flight 'download-started' listener

// Permanently drop the current item: a wrong match or a track Lucida does not have
// will fail identically on every retry, and retrying forever wedges the whole queue.
// No download began for the current item on this service. Lucida is flaky, so retry
// the same service a couple of times before moving down the fallback chain.
function handleNoStart(item, why) {
  if (!item || !activeDownloads[item.id]) return;
  const status = activeDownloads[item.id].status;
  if (status === 'skipped' || status === 'downloading') return;
  if (!currentProcessingItem || currentProcessingItem.id !== item.id) return; // already moved on

  clearTimeout(downloadTimeout);
  if (clearStartListener) { clearStartListener(); clearStartListener = null; }

  item.attempts = (item.attempts || 0) + 1;
  if (item.attempts >= MAX_START_ATTEMPTS) {
    tryFallbackOrAbandon(item, `${why} on ${serviceOf(item)} after ${item.attempts} attempts`);
    return;
  }

  const textEl = document.getElementById('dl-text-' + item.id);
  if (textEl) textEl.innerText = `${why} - retry ${item.attempts}/${MAX_START_ATTEMPTS}...`;
  if (item.groupId) updateGroupUI(item.groupId, item, 'Retrying');
  log('retry', { id: item.id, name: item.name, service: serviceOf(item), why,
                 attempt: item.attempts, max: MAX_START_ATTEMPTS });
  console.warn('[retry]', item.name, '|', serviceOf(item), '|', why, item.attempts + '/' + MAX_START_ATTEMPTS);

  currentProcessingItem = null;
  downloadQueue.unshift(item);
  persistSoon();
  setTimeout(processNextInQueue, 2000);
}

function tryNextSearchVariant(item, reason, detail) {
  const variants = item && item.searchVariants;
  const next = (item.searchVariantIndex || 0) + 1;
  if (!variants || next >= variants.length) return false;
  item.searchVariantIndex = next;
  item.url = lucidaSearchUrl(variants[next], serviceOf(item));
  item.attempts = 0;
  activeDownloads[item.id].status = 'queued';
  const textEl = document.getElementById('dl-text-' + item.id);
  if (textEl) textEl.innerText = `Trying another ${serviceLabel(serviceOf(item))} search…`;
  log('search.variant', { id: item.id, service: serviceOf(item), index: next, query: variants[next], reason, detail: detail || null });
  currentProcessingItem = null;
  downloadQueue.unshift(item);
  persistSoon();
  setTimeout(processNextInQueue, 500);
  return true;
}

// Before giving up on a track, re-search it on the next service in the chain.
// Only when the chain is exhausted does it actually get skipped.
function tryFallbackOrAbandon(item, reason, detail = null) {
  if (!item || !activeDownloads[item.id] || activeDownloads[item.id].status === 'skipped') return;

  const from = serviceOf(item);
  recordTried(item, from, detail ? `${reason} (best hit: ${detail})` : reason);

  const already = item.triedServices || (item.tried || []).map((t) => t.service);
  const service = FALLBACK_SERVICES.find((sv) => already.indexOf(sv) === -1 && !(serviceHealth[sv] && serviceHealth[sv].status === 'unavailable'));

  if (!item.searchQuery || !service) {
    if (item.ytFallbackUrl) {
      triggerYTDlpFallback(item, reason, detail);
    } else {
      abandonItem(item, reason, detail);
    }
    return;
  }

  clearTimeout(downloadTimeout);
  if (clearStartListener) { clearStartListener(); clearStartListener = null; }

  item.fallbackIndex = FALLBACK_SERVICES.indexOf(service);
  item.service = service; // what the index meant, in case the chain changes later
  item.attemptService = service;
  item.attempts = 0; // the attempt budget is per service
  item.searchVariantIndex = 0;
  item.url = lucidaSearchUrl((item.searchVariants || [item.searchQuery])[0], service);
  activeDownloads[item.id].status = 'queued';

  const fillEl = document.getElementById('dl-fill-' + item.id);
  const textEl = document.getElementById('dl-text-' + item.id);
  if (fillEl) { fillEl.style.width = '0%'; fillEl.style.background = '#007bff'; }
  if (textEl) textEl.innerText = `Not found on ${serviceLabel(from)} — checking ${serviceLabel(service)}`;
  updateCoverOverlay(item.id, 'searching');
  log('fallback', { id: item.id, name: item.name, from, to: service, reason, detail });
  console.warn('[fallback]', item.name, '|', from, '->', service, '|', reason);

  if (item.groupId) updateGroupUI(item.groupId, item, 'Trying ' + service);

  downloadQueue.unshift(item);
  if (currentProcessingItem && currentProcessingItem.id === item.id) currentProcessingItem = null;
  persistSoon();
  setTimeout(processNextInQueue, 1000);
}

async function triggerYTDlpFallback(item, reason, detail) {
  clearTimeout(downloadTimeout);
  if (clearStartListener) { clearStartListener(); clearStartListener = null; }
  
  const textEl = document.getElementById('dl-text-' + item.id);
  if (textEl) textEl.innerText = `Downloading via yt-dlp fallback...`;
  updateCoverOverlay(item.id, 'downloading');
  
  try {
    const ext = '.m4a';
    const folder = item.folderName || '';
    const safeName = item.name.replace(/[<>:"/\\|?*]+/g, '_');
    const savePath = await ipcRenderer.invoke('get-download-path'); // get base path
    const fullPath = folder ? savePath + '\\' + folder + '\\' + safeName + ext : savePath + '\\' + safeName + ext;
    
    await ipcRenderer.invoke('yt-download', { url: item.ytFallbackUrl, savePath: fullPath, itemId: item.id });
    
    recordTried(item, 'yt-dlp', 'Direct download');
    
    // Simulate the download-status event that a normal download would fire
    downloadFileMap['yt-fallback-' + item.id] = item.id;
    activeDownloads[item.id] = activeDownloads[item.id] || { item };
    
    // Dispatch it to myself so the UI updates
    const ev = new Event('download-status');
    ipcRenderer.emit('download-status', ev, { 
      file: 'yt-fallback-' + item.id, 
      status: 'completed', 
      service: 'youtube', 
      savePath: fullPath 
    });
  } catch (e) {
    abandonItem(item, 'yt-dlp fallback failed: ' + e.message, null);
  }
}

function abandonItem(item, reason, detail = null) {
  if (!item || !activeDownloads[item.id] || activeDownloads[item.id].status === 'skipped') return;
  clearTimeout(downloadTimeout);
  if (clearStartListener) { clearStartListener(); clearStartListener = null; }

  activeDownloads[item.id].status = 'skipped';
  const fillEl = document.getElementById('dl-fill-' + item.id);
  const textEl = document.getElementById('dl-text-' + item.id);
  if (fillEl) { fillEl.style.width = '100%'; fillEl.style.background = '#c8a415'; }
  if (textEl) textEl.innerText = detail ? `${reason} (best hit: ${detail})` : reason;
  updateCoverOverlay(item.id, 'skipped');
  recordTried(item, serviceOf(item), detail ? `${reason} (best hit: ${detail})` : reason);
  const tried = item.tried || [];
  log('skip', {
    id: item.id, name: item.name, title: item.title, artist: item.artist,
    reason, detail, servicesTried: tried.map((t) => t.service)
  });

  // The folder's own record of what it is missing. Nothing else survives the
  // session: the queue file is deleted once it drains and the log is per-run, so
  // without this there is no way to ask "what did this album never get?".
  ipcRenderer.send('report-track', {
    folderName: item.folderName,
    section: 'missing',
    entry: {
      title: item.title, artist: item.artist,
      group: item.groupName || null,
      searchQuery: item.searchQuery || null,
      reason, detail: detail || null, lastUrl: item.url || null,
      tried
    }
  });
  console.warn('[skipped]', item.name, '-', reason, detail ? '| best hit: ' + detail : '');

  if (item.groupId && groupStats[item.groupId]) {
    groupStats[item.groupId].skipped++;
    updateGroupUI(item.groupId, item);
  }
  updateBadge();
  persistSoon();

  if (currentProcessingItem && currentProcessingItem.id === item.id) {
    currentProcessingItem = null;
    setTimeout(processNextInQueue, 500);
  }
}

function processNextInQueue() {
  // A pause must not consume an item: leave the queue exactly as it is and let
  // setQueuePaused(false) call back in.
  if (queuePaused) {
    isProcessingQueue = false;
    currentProcessingItem = null;
    return;
  }

  if (downloadQueue.length === 0) {
    isProcessingQueue = false;
    currentProcessingItem = null;
    // Nothing left to resume. Drop the saved queue rather than replay it next
    // launch, where every item would just be skipped as already downloaded.
    if (!Object.values(activeDownloads).some((d) => d.status === 'queued' || d.status === 'downloading')) {
      persistCancel();
      ipcRenderer.send('queue-clear');
    }
    return;
  }
  
  isProcessingQueue = true;
  currentProcessingItem = downloadQueue.shift();
  updateQueueStatus();
  // The item was already present in the last snapshot. Leaving it there until it
  // reaches a terminal state is both crash-safe and avoids rewriting a full queue
  // for every dequeue.
  
  if (currentProcessingItem.groupId && groupStats[currentProcessingItem.groupId]) {
      groupStats[currentProcessingItem.groupId].downloading = true;
      updateGroupUI(currentProcessingItem.groupId, currentProcessingItem, 'Fetching');
  }
  
  currentProcessingItem.originalService = currentProcessingItem.originalService || serviceFromUrl(currentProcessingItem.url) || currentProcessingItem.service || 'lucida';
  currentProcessingItem.attemptService = currentProcessingItem.attemptService || currentProcessingItem.originalService;
  currentProcessingItem.triedServices = currentProcessingItem.triedServices || (currentProcessingItem.tried || []).map((t) => t.service || t).filter(Boolean);
  currentProcessingItem.searchVariants = currentProcessingItem.searchVariants || [currentProcessingItem.searchQuery || buildSearchQuery(currentProcessingItem.title, currentProcessingItem.artist)];
  currentProcessingItem.searchVariantIndex = currentProcessingItem.searchVariantIndex || 0;
  currentProcessingItem.attemptStartedAt = Date.now();
  log('attempt.start', {
    id: currentProcessingItem.id, name: currentProcessingItem.name,
    service: serviceOf(currentProcessingItem), fallbackIndex: currentProcessingItem.fallbackIndex,
    attempt: (currentProcessingItem.attempts || 0) + 1, url: currentProcessingItem.url,
    queueDepth: downloadQueue.length
  });

  const textEl = document.getElementById('dl-text-' + currentProcessingItem.id);
  if (textEl) textEl.innerText = 'Fetching...';
  updateCoverOverlay(currentProcessingItem.id, 'searching');

  ipcRenderer.send('set-next-download-folder', {
    itemId: currentProcessingItem.id,
    folderName: currentProcessingItem.folderName,
    artworkUrl: currentProcessingItem.groupArtwork,
    key: currentProcessingItem.key, // lets the main process record it as downloaded
    // for the folder report: only the main process sees the finished file, only
    // the renderer knows which track and which store it belongs to
    title: currentProcessingItem.title,
    artist: currentProcessingItem.artist,
    group: currentProcessingItem.groupName || null,
    originalService: currentProcessingItem.originalService,
    attemptService: currentProcessingItem.attemptService,
    service: serviceOf(currentProcessingItem),
    sourceUrl: currentProcessingItem.url,
    tried: currentProcessingItem.tried || [],
    triedServices: currentProcessingItem.triedServices || []
  });
  
  let started = false;
  
  const onStart = (event, payload) => {
    if (payload && payload.itemId && payload.itemId !== currentProcessingItem.id) return;
    started = true;
    ipcRenderer.removeListener('download-started', onStart);
    clearStartListener = null;
    clearTimeout(downloadTimeout);
  };

  ipcRenderer.on('download-started', onStart);
  clearStartListener = () => ipcRenderer.removeListener('download-started', onStart);
  
  lastHandledDownloadUrl = null; // allow the cascade to re-run on retry
  if (downloadView.src === currentProcessingItem.url) {
    downloadView.reload();
  } else {
    downloadView.src = currentProcessingItem.url;
  }
  
  downloadTimeout = setTimeout(() => {
    if (!started) handleNoStart(currentProcessingItem, 'Timed out');
  }, 120000);
}

downloadView.addEventListener('dom-ready', async () => {
  const currentUrl = downloadView.getURL();
  if (!currentUrl || currentUrl === 'about:blank') return;
  // Guard against duplicate dom-ready events for the same page. This compares the
  // WEBVIEW's url; comparing the renderer's own location to itself was always true
  // after the first event, which silently disabled this handler for every track.
  if (currentUrl === lastHandledDownloadUrl) return;
  lastHandledDownloadUrl = currentUrl;

  const expecting = currentProcessingItem || {};

  // The cascade must run INSIDE the webview. Executed in the renderer it only ever
  // queried index.html, so it never found a download button on the Lucida page.
  const script = `
    new Promise((resolve) => {
      const EXPECTED = ${JSON.stringify({ title: expecting.title || '', artist: expecting.artist || '' })};
      const MIN_TITLE_SCORE = ${MIN_TITLE_SCORE};

      // Lucida search hits are ranked by its own relevance, which happily returns a
      // different song when the wanted one is not on the service. Score every card
      // against the metadata we came in with and refuse anything unconvincing.
      const STOP = ['the','and','feat','ft','with','for','from','version','original'];
      // Markers that mean a DIFFERENT recording rather than different wording of
      // the same one. These must never be stopwords: while they were, the expected
      // "No Glory (Remix)" reduced to the single token "glory", so the remix, the
      // instrumental and a slowed+reverb edit all scored a perfect 1.0 and the queue
      // took whichever Lucida ranked first - it downloaded the slowed+reverb cut.
      // A mismatch on any of these, in either direction, is disqualifying.
      // "version"/"original" stay in STOP above: they describe the ordinary release
      // ("album version"), not an altered cut, and gating on them would reject good
      // hits like "Propane Nightmares (album version)".
      const ALTERING = ['remix','slowed','reverb','sped','instrumental','karaoke',
                        'live','acoustic','bootleg','mashup','nightcore','cover'];
      // Stroked/ligature letters have no NFD decomposition, so without an explicit
      // fold they become spaces and shatter a word into unmatchable fragments
      // ("Poloz" -> "po oz"). Spotify metadata is full of them.
      const FOLD = { 'ł':'l','ø':'o','đ':'d','ð':'d','þ':'th','æ':'ae','œ':'oe',
                     'ß':'ss','ı':'i','ħ':'h','ŋ':'n','ŧ':'t','ĸ':'k' };
      const norm = (s) => (s || '')
        .normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9\\s]/g, (c) => FOLD[c] || ' ')
        .replace(/\\s+/g, ' ').trim();
      const toks = (s) => norm(s).split(' ').filter(t => t.length >= 3 && STOP.indexOf(t) === -1);

      const score = (candTitle, candArtist) => {
        const et = toks(EXPECTED.title);
        const ct = toks(candTitle), ca = toks(candArtist);
        if (et.length === 0) return { t: 0, a: 0 };
        let hit = 0;
        for (const t of et) if (ct.indexOf(t) !== -1) hit++;
        let t = hit / et.length;
        // a version marker on one side but not the other means a different cut
        for (const m of ALTERING) {
          if ((et.indexOf(m) !== -1) !== (ct.indexOf(m) !== -1)) { t = 0; break; }
        }
        // Match a WHOLE credited name, not any one shared token - "Billy Joel" used
        // to satisfy a search for "Joel Nielsen" on the strength of "joel" alone.
        // Spotify credits several artists comma-separated and Lucida usually lists
        // only one, so any single credit matching in full is enough. An artist can
        // also show up inside the candidate's title ("Track (Someone Remix)"), so
        // check both fields before giving up.
        const names = (EXPECTED.artist || '').split(/[,&]/).map(toks).filter((n) => n.length);
        let artistOk = names.length === 0 ? 1 : 0;
        for (const n of names) {
          if (n.every((tk) => ca.indexOf(tk) !== -1 || ct.indexOf(tk) !== -1)) { artistOk = 1; break; }
        }
        return { t, a: artistOk };
      };

      let emptyPolls = 0; // consecutive polls showing a rendered but empty result list

      const attemptClick = () => {
        // 1. On a search results page, pick the best-matching hit - not blindly the first.
        if (location.href.includes('/search')) {
          const errorEl = document.querySelector('.error h2, .error p');
          if (errorEl && /uh-oh|no results/i.test(errorEl.innerText || '')) {
            resolve({ outcome: 'no-results' });
            return true;
          }

          const cards = Array.from(document.querySelectorAll('.search-result'));
          if (cards.length === 0) {
            // A service with nothing to offer does NOT render an .error element - it
            // renders the ordinary search scaffold ("Tracks"/"Albums" headings) with
            // zero cards. Without spotting that, an empty result set is
            // indistinguishable from a slow one and costs the full outer timeout.
            const scaffold = Array.from(document.querySelectorAll('h2'))
              .some(h => /tracks|albums/i.test(h.innerText || ''));
            if (scaffold && ++emptyPolls >= 16) { resolve('no-results'); return true; }
            return false; // still loading - keep polling
          }
          emptyPolls = 0;

          const scored = [];
          for (const card of cards) {
            const linkEl = card.querySelector('.metadata a');
            if (!linkEl || !linkEl.href) continue;
            const titleEl = card.querySelector('.metadata h1');
            const artistEl = card.querySelector('.metadata h2');
            const cand = {
              href: linkEl.href,
              title: titleEl ? titleEl.innerText.trim() : '',
              artist: artistEl ? artistEl.innerText.trim() : ''
            };
            cand.s = score(cand.title, cand.artist);
            scored.push(cand);
          }
          scored.sort((x, y) => (y.s.a - x.s.a) || (y.s.t - x.s.t));
          const best = scored[0] || null;

          // the top few WITH their scores - this is what makes the log useful for
          // tuning MIN_TITLE_SCORE later, rather than just knowing something failed
          const candidates = scored.slice(0, 5).map((c) => ({
            title: c.title, artist: c.artist,
            t: Math.round(c.s.t * 100) / 100, a: c.s.a
          }));
          const label = best ? best.title + ' - ' + best.artist : 'none';

          if (!best || best.s.a !== 1 || best.s.t < MIN_TITLE_SCORE) {
            resolve({ outcome: 'no-match', label, candidates, considered: scored.length });
            return true;
          }
          location.href = best.href;
          resolve({ outcome: 'navigating', label, candidates, considered: scored.length });
          return true;
        }

        // 2. Main album/track download button.
        const mainBtn = document.querySelector('.download-button');
        if (mainBtn) { mainBtn.click(); resolve({ outcome: 'clicked-download-button' }); return true; }

        // 3. Track-level download icon.
        const iconImg = document.querySelector('button img[alt*="ownload"], button img[src*="download"]');
        if (iconImg && iconImg.closest('button')) {
          iconImg.closest('button').click();
          resolve({ outcome: 'clicked-icon' });
          return true;
        }

        // 4. Text fallbacks.
        for (const el of document.querySelectorAll('button, a, div[role="button"]')) {
          const text = (el.innerText || el.textContent || '').toLowerCase().trim();
          if (text.includes('download track') || text === 'download' ||
              text.includes('download album') || text.includes('download full')) {
            el.click();
            resolve({ outcome: 'clicked-text' });
            return true;
          }
        }
        return false;
      };

      if (attemptClick()) return;
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        if (attemptClick()) { clearInterval(interval); }
        else if (attempts > 60) { clearInterval(interval); resolve({ outcome: 'timeout' }); }
      }, 500);
    });
  `;

  let outcome;
  try {
    outcome = await downloadView.executeJavaScript(script);
  } catch (err) {
    console.warn('[download-view] injection failed:', err.message);
    return;
  }
  const res = (outcome && typeof outcome === 'object') ? outcome : { outcome: String(outcome) };
  const service = serviceOf(expecting);
  console.log('[download-view]', res.outcome, res.label || '', '<-', currentUrl);

  log('attempt.outcome', {
    id: expecting.id, name: expecting.name, service, outcome: res.outcome,
    label: res.label || null, considered: res.considered || 0,
    ms: Date.now() - (expecting.attemptStartedAt || Date.now()), url: currentUrl
  });
  if (res.candidates && res.candidates.length) {
    log('match.candidates', {
      id: expecting.id, service, wanted: { title: expecting.title, artist: expecting.artist },
      accepted: res.outcome === 'navigating', minTitleScore: MIN_TITLE_SCORE,
      candidates: res.candidates
    });
  }

  // A wrong-song match or a track this store does not carry will never succeed on
  // retry, so move to the next service rather than blocking the queue forever.
  if (res.outcome === 'no-match') {
    if (!tryNextSearchVariant(expecting, 'no-match', res.label)) tryFallbackOrAbandon(expecting, `No confident match on ${service}`, res.label);
  } else if (res.outcome === 'no-results') {
    if (!tryNextSearchVariant(expecting, 'no-results')) tryFallbackOrAbandon(expecting, `Not on ${service}`);
  } else if (res.outcome === 'timeout') {
    // the page rendered but offered nothing clickable; no point waiting out the
    // 120s start timer as well
    handleNoStart(expecting, 'No download control found');
  }
});

const downloadsList = document.getElementById('downloads-list');
const removeAllBtn = document.getElementById('remove-all-btn');
if (removeAllBtn) removeAllBtn.addEventListener('click', removeAllFromQueue);
const dlBadge = document.getElementById('dl-badge');
let activeDownloads = {};
let downloadSpeeds = {};
let persistedDownloadIds = new Set();
const pendingProgress = new Map();
let progressFrame = null;

ipcRenderer.on('download-started', (event, { file, total, service, itemId, savePath }) => {
  if (currentProcessingItem) {
    log('download.mapped', {
      id: currentProcessingItem.id, name: currentProcessingItem.name, file, total,
      service: serviceOf(currentProcessingItem),
      msToStart: Date.now() - (currentProcessingItem.attemptStartedAt || Date.now())
    });
    if (!activeDownloads[currentProcessingItem.id]) return; // removed mid-start
    if (itemId && itemId !== currentProcessingItem.id) return;
    currentProcessingItem.attemptService = normalizeService(service) || currentProcessingItem.attemptService;
    downloadFileMap[file] = currentProcessingItem.id;
    activeDownloads[currentProcessingItem.id].savePath = savePath || null;
    activeDownloads[currentProcessingItem.id].mappedFilename = file;
    
    if (currentProcessingItem.groupId) {
       updateGroupUI(currentProcessingItem.groupId, currentProcessingItem, 'Downloading');
    }
    
    const textEl = document.getElementById('dl-text-' + currentProcessingItem.id);
    if (textEl) textEl.innerText = 'Starting download from ' + serviceLabel(currentProcessingItem.attemptService) + '...';
    updateCoverOverlay(currentProcessingItem.id, 'downloading');
    
    // UI Indicator for sidebar
    const ind = document.getElementById('current-download-indicator');
    if (ind) {
      ind.style.display = 'block';
      document.getElementById('cd-art').src = currentProcessingItem.image || currentProcessingItem.groupArtwork || '';
      document.getElementById('cd-title').innerText = currentProcessingItem.name;
      document.getElementById('cd-artist').innerText = (currentProcessingItem.texts || [])[1] || '';
      document.getElementById('cd-progress').style.width = '0%';
    }
    
    updateBadge();
  }
});

function renderDownloadProgress(file, received, total) {
  const id = downloadFileMap[file];
  if (!id) return;
  
  const now = Date.now();
  if (!downloadSpeeds[id]) {
      downloadSpeeds[id] = { lastReceived: received, lastTime: now, speedStr: '...' };
  } else {
      const diff = now - downloadSpeeds[id].lastTime;
      if (diff > 500) { 
          const bytes = received - downloadSpeeds[id].lastReceived;
          const bps = (bytes / diff) * 1000;
          let speedStr = bps > 1024 * 1024 ? (bps / 1024 / 1024).toFixed(1) + ' MB/s' : (bps / 1024).toFixed(0) + ' KB/s';
          downloadSpeeds[id] = { lastReceived: received, lastTime: now, speedStr };
      }
  }

  const fillEl = document.getElementById('dl-fill-' + id);
  const textEl = document.getElementById('dl-text-' + id);
  const rec = activeDownloads[id];
  const source = rec && rec.item ? serviceLabel(rec.item.attemptService || rec.item.originalService) : null;

  if (rec) rec.bytes = received;
  
  let pct = 0;
  if (total) pct = Math.round((received / total) * 100);

  if (fillEl && textEl) {
    const speedStr = downloadSpeeds[id].speedStr;
    const downloadedMB = (received / 1024 / 1024).toFixed(2) + ' MB';
    if (total) {
      const totalMB = (total / 1024 / 1024).toFixed(2) + ' MB';
      fillEl.style.width = pct + '%';
      textEl.innerText = `${pct}% • ${speedStr} • ${downloadedMB} / ${totalMB}` + (source ? ` • ${source}` : '');
    } else {
      textEl.innerText = `Downloading • ${speedStr} • ${downloadedMB}` + (source ? ` • ${source}` : '');
    }
  }
  
  // Update sidebar if this is the active download
  const ind = document.getElementById('current-download-indicator');
  if (ind && ind.style.display === 'block') {
    const titleEl = document.getElementById('cd-title');
    if (titleEl && rec && rec.item && titleEl.innerText === rec.item.name) {
       document.getElementById('cd-progress').style.width = pct + '%';
    }
  }
}

ipcRenderer.on('download-progress', (event, { file, received, total }) => {
  pendingProgress.set(file, { received, total });
  if (progressFrame !== null) return;
  progressFrame = requestAnimationFrame(() => {
    progressFrame = null;
    pendingProgress.forEach((progress, name) => renderDownloadProgress(name, progress.received, progress.total));
    pendingProgress.clear();
  });
});

ipcRenderer.on('download-status', (event, { file, status, service, savePath }) => {
  const id = downloadFileMap[file];
  // No record means the item was removed from the queue while it was in flight;
  // the 'cancelled' that follows must not be retried back into existence.
  if (!id || !activeDownloads[id]) return;

  const queueItem = activeDownloads[id].item;

  const fillEl = document.getElementById('dl-fill-' + id);
  const textEl = document.getElementById('dl-text-' + id);

  log('item.done', {
    id, name: queueItem.name, file, status, service: serviceOf(queueItem),
    fallbackIndex: queueItem.fallbackIndex, attempts: queueItem.attempts,
    msTotal: Date.now() - (queueItem.attemptStartedAt || Date.now())
  });

  if (status === 'completed') {
    queueItem.successfulService = normalizeService(service) || queueItem.attemptService || null;
    activeDownloads[id].status = 'completed';
    activeDownloads[id].savePath = savePath || activeDownloads[id].savePath || null;
    persistedDownloadIds.delete(id);
    updateBadge();

    // Hide sidebar indicator if it matches
    const ind = document.getElementById('current-download-indicator');
    if (ind && ind.style.display === 'block') {
      const titleEl = document.getElementById('cd-title');
      if (titleEl && titleEl.innerText === queueItem.name) {
        setTimeout(() => { ind.style.display = 'none'; }, 2000);
      }
    }
    
    if (fillEl && textEl) {
      fillEl.style.width = '100%';
      fillEl.style.background = '#28a745';
      textEl.innerText = 'Completed' + sizeSourceSuffix(id, queueItem);
    }
    updateCoverOverlay(id, 'completed');
    if (queueItem.groupId) {
      groupStats[queueItem.groupId].completed++;
      const sources = groupStats[queueItem.groupId].sources || (groupStats[queueItem.groupId].sources = {});
      const source = queueItem.successfulService || 'unknown';
      sources[source] = (sources[source] || 0) + 1;
      updateGroupUI(queueItem.groupId, queueItem); // pass queueItem to update the status text (or it will say Completed if 100%)
    }
    persistSoon();
    
    // Download finished successfully, process next!
    setTimeout(processNextInQueue, 1000);
  } else {
    // Failed or Cancelled - RETRY
    if (fillEl && textEl) {
      fillEl.style.background = '#dc3545';
      textEl.innerText = `Failed (${status}) - Retrying...`;
    }
    if (queueItem.groupId) {
       updateGroupUI(queueItem.groupId, queueItem, 'Failed - Retrying');
    }
    queueItem.attempts = (queueItem.attempts || 0) + 1;
    if (queueItem.attempts >= MAX_START_ATTEMPTS) {
      tryFallbackOrAbandon(queueItem, `Failed ${queueItem.attempts}x on ${serviceOf(queueItem)} (${status})`);
      return;
    }
    // Push back to front of queue to retry immediately
    downloadQueue.unshift(queueItem);
    setTimeout(processNextInQueue, 2000);
  }
  
  statusText.innerText = `Download ${status}: ${file}`;

  // Re-enable all download buttons
  const btns = document.querySelectorAll('.download-btn');
  btns.forEach(b => {
    if (b.innerText === 'Starting...') {
      b.innerText = 'Download';
      b.disabled = false;
    }
  });
});

function renderBadge() {
  // Counts anything still in flight (queued or actively downloading) so the
  // sidebar number jumps the instant a track is added, not once its transfer
  // actually starts.
  const activeCount = Object.values(activeDownloads).filter(d => d.status === 'queued' || d.status === 'downloading').length;
  if (activeCount > 0) {
    dlBadge.style.display = 'inline';
    dlBadge.innerText = activeCount;
  } else {
    dlBadge.style.display = 'none';
  }
}

// rAF-coalesced, same pattern as scheduleProfileUI - addDownloadToUI calls this
// once per item in a batch, and without coalescing that walk of activeDownloads
// makes a large enqueueAll quadratic.
let badgeFrame = null;
function updateBadge() {
  if (badgeFrame !== null) return;
  badgeFrame = requestAnimationFrame(() => {
    badgeFrame = null;
    renderBadge();
  });
}

// --------------------------------------------------------------------------
// Removing things from the queue
//
// Three levels have a remove control (track row, playlist, profile) and they all
// funnel into removeQueueItems. The item that is mid-flight is the interesting
// one: its transfer has to be cancelled in the main process, the in-page cascade
// stopped, and the queue advanced by hand - the same dance setQueuePaused does,
// because nothing else will move the queue on once its item is gone.
// --------------------------------------------------------------------------
let removedGroups = {}; // gid -> true, so an in-flight expansion drops its results
let expansionEpoch = 0; // bumped to abandon a running queueAllPlaylists loop

function idsWith(pred) {
  return Object.keys(activeDownloads).filter((id) => {
    const rec = activeDownloads[id];
    return rec && rec.item && pred(rec.item);
  });
}

// A playlist that was removed before it finished expanding leaves an empty
// container behind, as does one whose last row was removed by hand.
function pruneEmptyGroup(groupId) {
  const el = document.getElementById('group-' + groupId);
  const items = groupItems[groupId];
  if (items && items.size) return;
  if (el) el.remove();
  delete groupStats[groupId];
  delete groupItems[groupId];
  delete renderedGroupRowIds[groupId];
  const pid = groupProfile[groupId];
  delete groupProfile[groupId];
  if (!pid || !profileStats[pid]) return;
  const p = profileStats[pid];
  p.groups = p.groups.filter((g) => g !== groupId);
  p.expected = Math.max(0, p.expected - 1);
  if (p.expanded > p.expected) p.expanded = p.expected;
  if (p.groups.length === 0) {
    const pel = document.getElementById('profile-' + pid);
    if (pel) pel.remove();
    delete profileStats[pid];
  } else {
    updateProfileUI(pid);
  }
}

function showEmptyQueueMessage() {
  downloadsList.innerHTML = '<p style="color:#aaa;">No active downloads.</p>';
}

function removeQueueItems(ids, reason) {
  if (!ids || !ids.length) return 0;
  const set = {};
  ids.forEach((id) => { set[id] = true; });

  const liveRemoved = !!(currentProcessingItem && set[currentProcessingItem.id]);
  downloadQueue = downloadQueue.filter((it) => !set[it.id]);

  const touched = {};
  let removed = 0;
  ids.forEach((id) => {
    const rec = activeDownloads[id];
    if (!rec) return;
    const it = rec.item || {};
    const gs = it.groupId ? groupStats[it.groupId] : null;
    if (gs) {
      // the bar is settled/total, so both halves have to come back down
      gs.total = Math.max(0, gs.total - 1);
      if (rec.status === 'completed') gs.completed = Math.max(0, gs.completed - 1);
      if (rec.status === 'skipped') gs.skipped = Math.max(0, gs.skipped - 1);
      touched[it.groupId] = true;
      if (groupItems[it.groupId]) groupItems[it.groupId].delete(id);
      if (renderedGroupRowIds[it.groupId]) renderedGroupRowIds[it.groupId].delete(id);
    }
    if (rec.mappedFilename) delete downloadFileMap[rec.mappedFilename];
    delete activeDownloads[id];
    persistedDownloadIds.delete(id);
    delete downloadSpeeds[id];
    const row = document.getElementById('dl-' + id);
    if (row) row.remove();
    removed++;
  });

  if (liveRemoved) {
    ipcRenderer.send('downloads-cancel');
    clearTimeout(downloadTimeout);
    if (clearStartListener) { clearStartListener(); clearStartListener = null; }
    currentProcessingItem = null;
    isProcessingQueue = false;
    lastHandledDownloadUrl = null;
    downloadView.src = 'about:blank'; // stops the in-page cascade dead
  }

  Object.keys(touched).forEach((gid) => { updateGroupUI(gid); pruneEmptyGroup(gid); });
  updateBadge();
  updateQueueStatus();
  log('queue.remove', {
    count: removed, reason: reason || 'user', live: liveRemoved, depth: downloadQueue.length
  });

  if (Object.keys(activeDownloads).length === 0) {
    showEmptyQueueMessage();
    persistCancel();
    ipcRenderer.send('queue-clear');
  } else {
    persistSoon();
  }

  if (liveRemoved && !queuePaused) processNextInQueue();
  return removed;
}

function removeGroup(groupId, groupName) {
  const ids = idsWith((it) => it.groupId === groupId);
  if (ids.length > 5 &&
      !confirm('Remove ' + ids.length + ' tracks in "' + (groupName || 'this playlist') + '" from the queue?')) {
    return;
  }
  removedGroups[groupId] = true; // an expansion still running must drop its results
  removeQueueItems(ids, 'group');
  pruneEmptyGroup(groupId); // it may never have expanded, so have had no rows at all
}

function removeProfile(profileId) {
  const p = profileStats[profileId];
  const ids = idsWith((it) => it.profileId === profileId);
  const label = p ? p.name : 'this profile';
  if (!confirm('Remove ' + (p ? p.expected + ' playlists' : 'everything') +
               ' from "' + label + '"' + (ids.length ? ' (' + ids.length + ' tracks)' : '') + '?')) {
    return;
  }
  expansionEpoch++; // stop queueAllPlaylists adding any more of it
  (p ? p.groups.slice() : []).forEach((gid) => { removedGroups[gid] = true; });
  removeQueueItems(ids, 'profile');
  (p ? p.groups.slice() : []).forEach(pruneEmptyGroup);
  const pel = document.getElementById('profile-' + profileId);
  if (pel && !pel.querySelector('.download-item')) {
    pel.remove();
    delete profileStats[profileId];
  }
  if (Object.keys(activeDownloads).length === 0) showEmptyQueueMessage();
}

function removeAllFromQueue() {
  const n = Object.keys(activeDownloads).length;
  if (!n) { statusText.innerText = 'The queue is already empty.'; return; }
  if (!confirm('Remove all ' + n + ' item' + (n === 1 ? '' : 's') + ' from the queue?\n\n' +
               'Files already downloaded stay on disk.')) return;

  expansionEpoch++;
  ipcRenderer.send('downloads-cancel');
  clearTimeout(downloadTimeout);
  if (clearStartListener) { clearStartListener(); clearStartListener = null; }

  downloadQueue = [];
  currentProcessingItem = null;
  isProcessingQueue = false;
  lastHandledDownloadUrl = null;
  downloadView.src = 'about:blank';

  activeDownloads = {};
  downloadSpeeds = {};
  persistedDownloadIds = new Set();
  downloadFileMap = {};
  groupStats = {};
  groupProfile = {};
  profileStats = {};
  removedGroups = {};

  showEmptyQueueMessage();
  updateBadge();
  updateQueueStatus();
  persistCancel();
  ipcRenderer.send('queue-clear');
  log('queue.remove.all', { count: n });
  statusText.innerText = 'Removed ' + n + ' item' + (n === 1 ? '' : 's') + ' from the queue.';
}


// --------------------------------------------------------------------------
// Pause / resume
//
// Two separate things stop: the transfer in flight (the main process pauses the
// DownloadItem) and the queue itself. If the current item has not reached a
// download yet, it goes back to the front of the queue untouched and its page is
// thrown away - the injected cascade is still polling in there, and letting it
// reach a click while paused would start the very download the user just stopped.
// Its attempt count is deliberately not incremented: a pause is not a failed
// attempt, and burning the budget here would push the track onto the fallback
// chain for no reason.
// --------------------------------------------------------------------------
const pauseBtn = document.getElementById('pause-btn');
const queueNote = document.getElementById('queue-note');

function updatePauseUI() {
  if (pauseBtn) {
    pauseBtn.innerText = queuePaused ? 'Resume' : 'Pause';
    pauseBtn.style.background = queuePaused ? '#28a745' : '#007bff';
  }
  if (queueNote) queueNote.innerText = queuePaused ? 'Paused' : '';
}

function setQueuePaused(paused) {
  if (paused === queuePaused) return;
  queuePaused = paused;
  updatePauseUI();
  log(paused ? 'queue.pause' : 'queue.resume', { depth: downloadQueue.length });

  if (paused) {
    ipcRenderer.send('downloads-pause');
    const item = currentProcessingItem;
    const state = item && activeDownloads[item.id] ? activeDownloads[item.id].status : null;
    if (item && state !== 'downloading' && state !== 'skipped') {
      clearTimeout(downloadTimeout);
      if (clearStartListener) { clearStartListener(); clearStartListener = null; }
      currentProcessingItem = null;
      isProcessingQueue = false;
      downloadQueue.unshift(item);
      lastHandledDownloadUrl = null;
      downloadView.src = 'about:blank'; // stops the in-page cascade dead
      const textEl = document.getElementById('dl-text-' + item.id);
      if (textEl) textEl.innerText = 'Paused';
    }
  } else {
    ipcRenderer.send('downloads-resume');
    // a download still in flight resumes on its own; only an idle queue needs a kick
    if (!currentProcessingItem) processNextInQueue();
  }
  persistSoon();
}

if (pauseBtn) pauseBtn.addEventListener('click', () => setQueuePaused(!queuePaused));

// --------------------------------------------------------------------------
// Resume across restarts
//
// state/queue.json holds outstanding and skipped items. Completed tracks live in
// the manifest, so a crash during a run restores only the work that still needs
// a queue row; each restored item is re-checked against disk before re-queueing.
//
// Previously skipped tracks stay skipped. A skip means the fallback chain was
// exhausted, and re-running it on every launch pays the full per-service budget to
// arrive at the same answer.
// --------------------------------------------------------------------------
function snapshot() {
  return {
    v: 2,
    at: Date.now(),
    paused: queuePaused,
    // Completed downloads are in the manifest and do not need to bloat the
    // recoverable queue. Keeping only IDs that can still resume makes snapshots
    // bounded by outstanding work rather than the entire session history.
    items: Array.from(persistedDownloadIds).map((id) => Object.assign({}, activeDownloads[id].item, {
      status: activeDownloads[id].status
    }))
  };
}

let persistTimer = null;
let lastPersistLeadingAt = 0;
const PERSIST_DEBOUNCE_MS = 2000;

function persistSoon() {
  clearTimeout(persistTimer);
  // Leading-edge write: if we've been idle for a while, persist immediately in
  // addition to scheduling the trailing debounced call, so a burst of activity
  // after a quiet period isn't stuck waiting the full debounce window.
  const now = Date.now();
  if (now - lastPersistLeadingAt >= PERSIST_DEBOUNCE_MS) {
    lastPersistLeadingAt = now;
    ipcRenderer.send('queue-save', snapshot());
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    lastPersistLeadingAt = Date.now();
    ipcRenderer.send('queue-save', snapshot());
  }, PERSIST_DEBOUNCE_MS);
}

function persistCancel() {
  clearTimeout(persistTimer);
  persistTimer = null;
}

async function restoreSession() {
  let snap = null;
  try { snap = await ipcRenderer.invoke('queue-load'); } catch (e) { return; }
  if (!snap || !Array.isArray(snap.items) || snap.items.length === 0) return;

  let checks = [];
  try {
    checks = await ipcRenderer.invoke('downloads-check', snap.items.map((i) => ({
      key: i.key, folderName: i.folderName, title: i.title
    })));
  } catch (e) { console.warn('[restore] existing-file check failed:', e.message); }

  // group totals have to exist before the first row is rendered - the summary
  // template prints them
  snap.items.forEach((i) => {
    if (!i.groupId) return;
    if (!groupStats[i.groupId]) groupStats[i.groupId] = { total: 0, completed: 0, skipped: 0, downloading: false, sources: {} };
    groupStats[i.groupId].total++;
  });

  // Same for the profile above them. Only playlists that actually produced items
  // are in the snapshot, so what comes back is what had been expanded - which is
  // exactly what 'expected' should be on a restored run.
  snap.items.forEach((i) => {
    if (!i.groupId || !i.profileId) return;
    if (!profileStats[i.profileId]) {
      profileStats[i.profileId] = {
        name: i.profileName || 'Profile', service: i.profileService || '',
        artwork: '', groups: [], expected: 0, expanded: 0
      };
    }
    if (groupProfile[i.groupId] !== i.profileId) {
      groupProfile[i.groupId] = i.profileId;
      profileStats[i.profileId].groups.push(i.groupId);
    }
  });
  Object.keys(profileStats).forEach((pid) => {
    profileStats[pid].expected = profileStats[pid].groups.length;
    profileStats[pid].expanded = profileStats[pid].groups.length;
  });

  let requeued = 0, alreadyDone = 0, staySkipped = 0;
  snap.items.forEach((item, idx) => {
    // ids must not collide with the restored ones
    const n = parseInt(String(item.id).replace('item-', ''), 10);
    if (!isNaN(n) && n >= downloadIdCounter) downloadIdCounter = n + 1;

    delete item.attemptStartedAt;
    addDownloadToUI(item);

    if (checks[idx] && checks[idx].done) {
      markAlreadyDownloaded(item, checks[idx]);
      alreadyDone++;
    } else if (item.status === 'skipped') {
      activeDownloads[item.id].status = 'skipped';
      const fillEl = document.getElementById('dl-fill-' + item.id);
      const textEl = document.getElementById('dl-text-' + item.id);
      if (fillEl) { fillEl.style.width = '100%'; fillEl.style.background = '#c8a415'; }
      if (textEl) textEl.innerText = 'Skipped in an earlier run';
      if (item.groupId) groupStats[item.groupId].skipped++;
      staySkipped++;
    } else {
      downloadQueue.push(item);
      requeued++;
    }
  });

  Object.keys(groupStats).forEach((g) => updateGroupUI(g));
  updateBadge();
  log('session.restore', { items: snap.items.length, requeued, alreadyDone, skipped: staySkipped, paused: !!snap.paused });

  updateQueueStatus();
  statusText.innerText = requeued
    ? `Restored ${requeued} pending track${requeued === 1 ? '' : 's'} (${alreadyDone} already downloaded).`
    : `Nothing left to download (${alreadyDone} already downloaded).`;

  if (requeued === 0) {
    persistCancel();
    ipcRenderer.send('queue-clear');
    return;
  }
  // write the reconciled statuses back, so the saved queue reflects what was
  // actually found on disk rather than what last run happened to leave behind
  persistSoon();

  if (snap.paused) { queuePaused = true; updatePauseUI(); }
  else processNextInQueue();
}

async function boot() {
  try {
    config = await ipcRenderer.invoke('get-config');
  } catch (e) { console.warn('[config] load failed:', e.message); }
  if (pathDisplay) pathDisplay.value = config.downloadPath || '';
  if (speedInput) speedInput.value = config.speedLimitKBps || 0;
  if (speedNote) speedNote.innerText = describeSpeed(config.speedLimitKBps || 0);
  if (scanChk) scanChk.checked = !!config.scanFolderForExisting;
  applyServiceConfig(config.fallbackServices, 'config');
  renderServiceChoices();
  updatePauseUI();
  await restoreSession();
}

boot();
