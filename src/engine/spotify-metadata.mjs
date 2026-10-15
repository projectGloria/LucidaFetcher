// All Spotify embed reads share pacing, retries and successful metadata caches.
// Artwork must not create a second, unthrottled stream beside playlist reads.
export const SPOTIFY_REQUEST_INTERVAL_MS = 500;
export const SPOTIFY_REQUEST_CONCURRENCY = 2;

export function parseSpotifyEmbed(html) {
  const match = String(html).match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  return JSON.parse(match[1]);
}

export function createSpotifyMetadata({ fetch: fetchPage, cache, log = () => {},
  now = Date.now, sleep = ms => new Promise(done => setTimeout(done, ms)),
  intervalMs = SPOTIFY_REQUEST_INTERVAL_MS, concurrency = SPOTIFY_REQUEST_CONCURRENCY,
} = {}) {
  const memory = new Map(), pending = new Map(), queue = [];
  let active = 0, nextStart = 0, cooldown = 0, failedUntil = 0;
  let launch = Promise.resolve();
  const rateLimitError = () => new Error(`Spotify is temporarily limiting requests. Try again in ${Math.max(1, Math.ceil((Math.max(cooldown, failedUntil) - now()) / 1000))} seconds.`);
  const takeTurn = () => {
    const turn = launch.then(async () => {
      // A request already in flight can extend the shared cooldown while this
      // one waits, so check again after each sleep.
      while (Math.max(nextStart, cooldown) > now()) {
        if (failedUntil > now()) throw rateLimitError();
        await sleep(Math.min(1000, Math.max(nextStart, cooldown) - now()));
      }
      if (failedUntil > now()) throw rateLimitError();
      nextStart = now() + intervalMs;
    });
    launch = turn.catch(() => {});
    return turn;
  };
  const pump = () => {
    queue.sort((a, b) => a.priority - b.priority);
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      active++;
      job.run().then(job.done, job.fail).finally(() => { active--; pump(); });
    }
  };
  const schedule = (run, priority) => new Promise((done, fail) => {
    queue.push({ run, priority, done, fail });
    pump();
  });
  async function fetchData(url) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (failedUntil > now()) throw rateLimitError();
      await takeTurn();
      let response;
      try { response = await fetchPage(url, { signal: AbortSignal.timeout(20000) }); }
      catch (error) {
        if (attempt === 2) throw error;
        cooldown = Math.max(cooldown, now() + 1000 * 2 ** attempt);
        continue;
      }
      const status = response?.status || 200;
      log('source.spotify.http', { path: new URL(url).pathname, status, attempt: attempt + 1 });
      if (status === 404) return null;
      if (status === 429 || status >= 500) {
        const retry = response.headers?.get?.('retry-after');
        const seconds = retry && Number(retry);
        const date = retry && Date.parse(retry);
        const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000
          : Number.isFinite(date) ? Math.max(1000, date - now()) : (status === 429 ? 15000 : 2000) * 2 ** attempt;
        cooldown = Math.max(cooldown, now() + wait);
        if (attempt === 2) failedUntil = Math.max(failedUntil, cooldown);
        await response.body?.cancel?.();
        if (attempt < 2) continue;
        throw status === 429 ? rateLimitError() : new Error(`Spotify metadata is unavailable (HTTP ${status}). Try again later.`);
      }
      if (!response || response.ok === false) throw new Error(`Spotify metadata request failed (HTTP ${status}).`);
      const data = parseSpotifyEmbed(await response.text());
      if (!data?.props?.pageProps?.state?.data?.entity) throw new Error('Spotify returned a page without playlist metadata. Try again later.');
      return data;
    }
  }
  return function read(url) {
    const parsed = new URL(url);
    if (parsed.hostname !== 'open.spotify.com') return Promise.reject(new Error('Unsupported Spotify host'));
    const path = parsed.pathname.replace(/^\/(?:intl-[a-z]{2}\/)?(?:embed\/)?/, '');
    if (!/^(playlist|album|track)\/[A-Za-z0-9]+\/?$/.test(path)) return Promise.reject(new Error('Invalid Spotify link'));
    const embedUrl = 'https://open.spotify.com/embed/' + path.replace(/\/$/, '');
    const ttl = path.startsWith('track/') ? 7 * 24 * 60 * 60 * 1000 : 10 * 60 * 1000;
    const valid = record => record?.at != null && now() - record.at < ttl && !!record.data?.props?.pageProps?.state?.data?.entity;
    if (valid(memory.get(embedUrl))) return Promise.resolve(memory.get(embedUrl).data);
    if (pending.has(embedUrl)) return pending.get(embedUrl);
    const key = 'spotify-embed-v1:' + path;
    const work = (async () => {
      let stored;
      try { stored = await cache?.get?.(key); } catch { /* cache failure does not prevent an import */ }
      if (valid(stored)) { memory.set(embedUrl, stored); return stored.data; }
      const data = await schedule(() => fetchData(embedUrl), path.startsWith('track/') ? 1 : 0);
      if (data) {
        const record = { at: now(), data };
        memory.set(embedUrl, record);
        try { await cache?.set?.(key, record); } catch { /* retain the successful read */ }
      }
      return data;
    })();
    pending.set(embedUrl, work);
    work.then(() => pending.delete(embedUrl), () => pending.delete(embedUrl));
    return work;
  };
}
