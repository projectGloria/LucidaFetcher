// Shared by every worker. Music services behind Lucida share one request budget.
export function abortError() {
  return Object.assign(new Error('aborted'), { name: 'Aborted' });
}

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(abortError()); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function retryAfterMs(value, now = Date.now()) {
  if (value == null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const ms = Number(text) * 1000;
    return Number.isFinite(ms) ? ms : null;
  }
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export function normalizeApiUrl(value) {
  if (!String(value || '').trim()) return '';
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('Enter a valid HTTP or HTTPS API URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP or HTTPS API URL without credentials, a query, or a fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

export class SourceAccess {
  constructor({ now = Date.now, sleep = delay, intervalMs = 2000, regions = {}, cooldowns = {}, onChange = () => {} } = {}) {
    this.now = now;
    this.sleep = sleep;
    this.intervalMs = intervalMs;
    this.onChange = onChange;
    this.regions = { ...regions };
    this.cooldowns = { ...cooldowns };
    this.states = new Map();
    this.cache = new Map();
  }

  key(step) { return ['monochrome', 'hifi-tidal'].includes(step.source) ? 'monochrome' : step.source === 'squid-qobuz' ? 'squid-qobuz' : 'lucida'; }

  state(key) {
    if (!this.states.has(key)) this.states.set(key, { active: false, queue: [], next: 0, strikes: 0 });
    return this.states.get(key);
  }

  async acquire(key, signal) {
    if (signal?.aborted) throw abortError();
    const state = this.state(key);
    await new Promise((resolve, reject) => {
      const waiter = { start: () => { signal?.removeEventListener('abort', abort); state.active = true; resolve(); } };
      const abort = () => {
        state.queue = state.queue.filter(w => w !== waiter);
        reject(abortError());
      };
      if (!state.active) waiter.start();
      else { state.queue.push(waiter); signal?.addEventListener('abort', abort, { once: true }); }
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.active = false;
      state.queue.shift()?.start();
    };
  }

  async pace(key, signal, onWait = () => {}) {
    const state = this.state(key);
    for (;;) {
      if (signal?.aborted) throw abortError();
      const until = Math.max(state.next, Number(this.cooldowns[key]) || 0);
      const ms = until - this.now();
      if (ms <= 0) break;
      onWait(ms, Number(this.cooldowns[key]) > this.now());
      await this.sleep(Math.min(ms, 1000), signal);
    }
    state.next = this.now() + this.intervalMs;
  }

  limited(key, retryAfter) {
    const state = this.state(key);
    const fallback = Math.min(300000, 30000 * 2 ** Math.min(state.strikes++, 4));
    const wait = Math.max(1000, retryAfterMs(retryAfter, this.now()) ?? fallback);
    this.cooldowns[key] = Math.max(Number(this.cooldowns[key]) || 0, this.now() + wait);
    this.changed();
    return this.cooldowns[key];
  }

  healthy(key) { this.state(key).strikes = 0; }
  rememberRegion(service, country) {
    if (!country || this.regions[service] === country) return;
    this.regions[service] = country;
    this.changed();
  }
  forgetRegion(service) {
    if (!(service in this.regions)) return;
    delete this.regions[service];
    this.changed();
  }
  changed() { this.onChange({ sourceRegions: { ...this.regions }, sourceCooldowns: { ...this.cooldowns } }); }

  cacheKey(item, step) {
    return JSON.stringify([step.service, step.query, item.key, item.title, item.artist, item.durationSec, item.isrc]);
  }
  getRelease(key) {
    const hit = this.cache.get(key);
    if (!hit || hit.until <= this.now()) { this.cache.delete(key); return null; }
    return hit.url;
  }
  rememberRelease(key, url) {
    // Only reuse a public release page, never an expiring media URL or a result
    // for a different expected recording. Re-run matching on every visit.
    try {
      const parsed = new URL(url);
      if (parsed.origin !== 'https://lucida.to' || parsed.pathname.startsWith('/search')) return;
    } catch { return; }
    this.cache.delete(key);
    this.cache.set(key, { url, until: this.now() + 10 * 60 * 1000 });
    while (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
  }
}

// These are Monochrome's documented Dev Mode storage keys. Configure before
// opening the search route so its first API request uses the chosen backend.
export function monochromeConfigScript(endpoint) {
  return `(() => {
    if (location.origin !== 'https://monochrome.st') throw new Error('Unexpected Monochrome origin');
    const endpoint = ${JSON.stringify(normalizeApiUrl(endpoint))};
    localStorage.setItem('dev-mode-enabled', endpoint ? 'true' : 'false');
    if (endpoint) localStorage.setItem('dev-mode-url', endpoint);
    else localStorage.removeItem('dev-mode-url');
    return true;
  })()`;
}
