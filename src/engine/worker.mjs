// One worker: a webview plus the logic to carry a single attempt through it.
//
// Everything the worker touches is injected - the view, the IPC surface, the
// clock - so the whole attempt flow can be exercised in plain Node. The old
// code had this spread across processNextInQueue, a shared dom-ready listener
// and three fallback functions, all coordinating through module globals
// (currentProcessingItem, downloadTimeout, clearStartListener,
// lastHandledDownloadUrl). Those globals are exactly what made a second
// concurrent download impossible: there was only ever one of each.

import { buildLucidaScript } from './cascade-lucida.mjs';
import { buildMonochromeScript } from './cascade-monochrome.mjs';
import { SOURCE_MONOCHROME, SOURCE_SOUNDCLOUD, SOURCE_YOUTUBE, SOURCE_DIRECT } from './chain.mjs';
import { monochromeConfigScript } from './source-access.mjs';

export const DEFAULTS = {
  domReadyTimeoutMs: 45000,
  cascadeTimeoutMs: 90000,
  // Above the cascade script's own 90-poll (90s) ceiling, with headroom for the
  // menu-click/remux overhead between candidates - not a second budget on top
  // of it. It used to be 240s, which meant a bad track could park a slot for
  // up to 8 minutes (two attempts) doing nothing anyone could see.
  monochromeCascadeTimeoutMs: 100000,
  downloadStartTimeoutMs: 120000,
};

// How many alternate release pages one attempt may fall back to before the
// store is given up. Two, not more: each one is a full page load, and by the
// third-best hit the scorer's confidence is thin enough that the next store is
// the better bet.
export const MAX_ALTERNATE_HOPS = 2;

export function lucidaSearchUrl(query, service, country) {
  return `https://lucida.to/search?query=${encodeURIComponent(query)}&service=${service}${country ? '&country=' + encodeURIComponent(country) : ''}`;
}

export function monochromeSearchUrl(query) {
  return `https://monochrome.st/search/${encodeURIComponent(query)}`;
}

export function urlForStep(step) {
  if (step.source === SOURCE_MONOCHROME) return monochromeSearchUrl(step.query);
  return lucidaSearchUrl(step.query, step.service);
}

class Aborted extends Error {
  constructor() { super('aborted'); this.name = 'Aborted'; }
}

function withTimeout(promise, ms, onTimeout, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (fn, value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      fn(value);
    };
    const abort = () => finish(reject, new Aborted());
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(resolve, onTimeout()), ms);
  });
}

export class Worker {
  /**
   * @param deps {
   *   slot: number
   *   view: {
   *     webContentsId: number,
   *     navigate(url): void,
   *     onDomReady(cb): () => void,
   *     executeJavaScript(src): Promise<any>,
   *   }
   *   ipc: {
   *     setDownloadContext(ctx): void,
   *     clearDownloadContext(webContentsId): void,
   *     awaitDownload(itemId, signal): Promise<{ status, savePath, file, bytes }>,
   *     awaitDownloadStart?(itemId, signal): Promise<object|null>,
   *     searchYouTube(query, limit): Promise<candidate[]>,
   *     searchSoundCloud(query, limit): Promise<candidate[]>,
   *     searchJamendo(query, limit): Promise<candidate[]>,
   *     downloadYouTube(payload): Promise<any>,
   *   }
   *   log?: (evt, data) => void
   *   pipeline?: boolean   // hand the transfer off and free the view at start
   *   timeouts?: Partial<typeof DEFAULTS>
   * }
   */
  constructor(deps) {
    this.slot = deps.slot;
    this.view = deps.view;
    this.ipc = deps.ipc;
    this.log = deps.log || (() => {});
    this.access = deps.access;
    this.onWait = deps.onWait || (() => {});
    this.getMonochromeApiUrl = deps.getMonochromeApiUrl;
    // With the pipeline on, a scraped attempt ends when the transfer STARTS,
    // not when the file lands: the page has done its job by then and the bytes
    // are the main process's business. The caller waits for the file instead,
    // off the webview. Off by default so the worker's contract - "an outcome is
    // a finished attempt" - still holds for anyone who wants it.
    this.pipeline = !!deps.pipeline;
    this.t = { ...DEFAULTS, ...(deps.timeouts || {}) };
  }

  /**
   * Carry one attempt. Resolves with an outcome describing what happened;
   * it does not decide what to do next - that is the chain's job.
   */
  async run(item, step, signal) {
    if (signal && signal.aborted) throw new Aborted();
    const started = Date.now();
    const base = { step, slot: this.slot };
    const cancel = () => {
      this.ipc.cancelDownload?.(item.id);
      this.view.reset?.(); // navigating away stops a cascade that could still click after cancellation
    };
    signal?.addEventListener("abort", cancel, { once: true });

    let release, offResponse;
    const attempt = new AbortController();
    const abortAttempt = () => attempt.abort();
    signal?.addEventListener('abort', abortAttempt, { once: true });
    const source = this.access?.key(step);
    try {
      if (this.access) {
        this.onWait(item.id, step, null, false);
        release = await this.access.acquire(source, signal);
        await this.access.pace(source, signal, (ms, limited) => this.onWait(item.id, step, ms, limited));
      }
      this.onWait(item.id, step, 0, false);
      if (signal?.aborted) throw new Aborted();
      let networkResult;
      offResponse = this.ipc.onSourceResponse?.(this.view.webContentsId, item.id, response => {
        if (networkResult) return;
        if (response.status !== 429 && !(response.status === 403 && response.mainFrame)) return;
        const retryAt = response.status === 429 ? this.access?.limited(source, response.retryAfter) : null;
        networkResult = { outcome: response.status === 429 ? 'rate-limited' : 'access-blocked',
          httpStatus: response.status, retryAt, message: `HTTP ${response.status} from ${response.host}` };
        attempt.abort();
        this.view.reset?.();
      });
      let result;
      try { result = await this._dispatch(item, step, attempt.signal); }
      catch (error) { if (!networkResult) throw error; }
      result = networkResult || result;
      if (result.outcome === 'rate-limited' && !networkResult) {
        result.retryAt = this.access?.limited(source, result.retryAfter);
      }
      if (result.outcome === 'completed' || result.outcome === 'transferring') this.access?.healthy(source);
      else if (this.access) this.access.cache.delete(this.access.cacheKey(item, step));
      this.log('attempt.outcome', {
        id: item.id, name: item.name, service: step.service,
        outcome: result.outcome, label: result.label || null,
        message: result.message || null, url: result.url || null,
        candidates: result.candidates || null,
        httpStatus: result.httpStatus || null, retryAt: result.retryAt || null,
        ms: Date.now() - started,
      });
      return { ...base, ...result };
    } catch (err) {
      if (err instanceof Aborted || err.name === 'Aborted' || signal?.aborted) throw new Aborted();
      this.log('attempt.error', { id: item.id, service: step.service, message: err.message });
      return { ...base, outcome: 'error', message: err.message };
    } finally {
      offResponse?.();
      release?.();
      signal?.removeEventListener('abort', abortAttempt);
      signal?.removeEventListener('abort', cancel);
    }
  }

  _dispatch(item, step, signal) {
    if ([SOURCE_DIRECT, SOURCE_SOUNDCLOUD, SOURCE_YOUTUBE].includes(step.source)
        || [SOURCE_SOUNDCLOUD, SOURCE_YOUTUBE].includes(step.service)) {
      return { outcome: 'provider-failed', message: 'YouTube and SoundCloud downloads are disabled. FLAC only.' };
    }
    return this._runScraped(item, step, signal);
  }

  async _runScraped(item, step, signal) {
    const isMono = step.source === SOURCE_MONOCHROME;
    const searchUrl = isMono ? urlForStep(step) : lucidaSearchUrl(step.query, step.service, this.access?.regions[step.service]);
    const cacheKey = this.access?.cacheKey(item, step);
    const cached = !isMono && this.access?.getRelease(cacheKey);
    const url = cached || searchUrl;
    const endpoint = isMono ? this.getMonochromeApiUrl?.() : '';

    // The context must be registered BEFORE navigation: the page can trigger a
    // download the instant it loads, and will-download reads this map.
    this.ipc.setDownloadContext({
      webContentsId: this.view.webContentsId,
      itemId: item.id,
      folderName: item.folderName,
      artworkUrl: item.groupArtwork,
      key: item.key,
      title: item.title,
      artist: item.artist,
      durationSec: item.durationSec,
      isrc: item.isrc,
      group: item.groupName || null,
      service: step.service,
      attemptService: step.service,
      originalService: item.originalService || step.service,
      sourceUrl: url,
      apiUrl: endpoint || '',
    });

    try {
      const configuredEndpoint = this.access ? this.access.monochromeEndpoint : this._configuredEndpoint;
      if (isMono && this.getMonochromeApiUrl && configuredEndpoint !== endpoint) {
        // A same-origin text document has no app startup requests to race with
        // the setting. The actual search page loads after configuration.
        const ready = this._nextDomReady();
        try {
          this.view.navigate('https://monochrome.st/robots.txt');
          if (await withTimeout(ready, this.t.domReadyTimeoutMs, () => null, signal) === null) {
            return { outcome: 'navigation-timeout' };
          }
          const configured = await withTimeout(this.view.executeJavaScript(monochromeConfigScript(endpoint)),
            this.t.domReadyTimeoutMs, () => false, signal);
          if (configured !== true) return { outcome: 'error', message: 'Could not configure the Monochrome backend before the deadline' };
          this._configuredEndpoint = endpoint;
          if (this.access) this.access.monochromeEndpoint = endpoint;
        } finally { ready.cancel(); }
        await this.access?.pace(this.access.key(step), signal);
      }
      let outcome = await this._navigateAndInject(item, step, url, isMono, signal);
      if (cached && !['download-triggered', 'rate-limited', 'access-blocked'].includes(outcome.outcome) && !/^clicked-/.test(outcome.outcome)) {
        this.access.cache.delete(cacheKey);
        await this.access.pace(this.access.key(step), signal);
        outcome = await this._navigateAndInject(item, step, searchUrl, isMono, signal);
      }
      if (outcome.outcome !== 'download-triggered' &&
          !/^clicked-/.test(outcome.outcome)) {
        return outcome; // nothing is coming; leave the download context cleanup to finally
      }
      // A click is a promise of a file, not the file. Wait for the main process
      // to confirm one actually started.
      if (this.pipeline && this.ipc.awaitDownloadStart) {
        const begun = await this.ipc.awaitDownloadStart(item.id, signal);
        if (!begun) return { ...outcome, outcome: 'no-download-started' };
        // Handing back here is what frees the view. The download context was
        // consumed by will-download the moment the transfer began, so nothing
        // this page does next can reach the file that is already moving.
        return { outcome: 'transferring', label: outcome.label || null };
      }
      const done = await this.ipc.awaitDownload(item.id, signal);
      if (!done) return { ...outcome, outcome: 'no-download-started' };
      if (done.status !== 'completed') return { ...outcome, outcome: 'download-failed', message: done.status };
      return { outcome: 'completed', label: outcome.label || null, savePath: done.savePath, file: done.file, bytes: done.bytes };
    } finally {
      this.ipc.clearDownloadContext(this.view.webContentsId);
      // A timed-out injection keeps polling inside the page unless navigation
      // destroys it. It must not trigger a late download under the next context.
      this.view.reset?.();
    }
  }

  // Lucida is a two-page flow - search, then the release page - so a
  // 'navigating' outcome means "run again on the page it just went to".
  async _navigateAndInject(item, step, url, isMono, signal) {
    const expected = { title: item.title, artist: item.artist, durationSec: item.durationSec, isrc: item.isrc };
    const build = isMono ? buildMonochromeScript : buildLucidaScript;
    const cascadeMs = isMono ? this.t.monochromeCascadeTimeoutMs : this.t.cascadeTimeoutMs;

    // Armed before navigating so the event cannot land in the gap between the
    // call and the listener.
    let ready = this._nextDomReady();

    // Release pages the search scored as acceptable but did not navigate to.
    // The Lucida cascade has always returned these - a release page can be a
    // dead end, listed but carrying no usable download control, and that is a
    // fact about the PAGE rather than about the track - but nothing ever read
    // the field, so one dead release page wrote off the whole store.
    let alternates = [];
    const triedCountries = [];
    let selectedCountry = !isMono ? new URL(url).searchParams.get('country') : null;
    let releaseUrl = !isMono && !new URL(url).pathname.startsWith('/search') ? url : null;
    let last = { outcome: 'navigation-exhausted' };

    try {
      this.view.navigate(url);
      for (let hop = 0; hop < 6 + MAX_ALTERNATE_HOPS; hop++) {
        if (signal && signal.aborted) throw new Aborted();
        const arrived = await withTimeout(ready, this.t.domReadyTimeoutMs, () => null, signal);
        // Only the FIRST page failing to arrive says the store is unreachable.
        // Later on we already have a verdict worth reporting.
        if (arrived === null) return hop === 0 ? { outcome: 'navigation-timeout' } : last;

        // Re-arm BEFORE injecting. The search cascade navigates by assigning
        // location.href from inside the page, so the release page's dom-ready
        // can fire before the injected promise even resolves; arming afterwards
        // would miss it on a fast load and stall until the navigation timeout.
        ready.cancel();
        ready = this._nextDomReady();

        const res = await this._inject(build(expected, { managedNavigation: true, triedCountries }), cascadeMs, signal);
        const outcome = (res && typeof res === 'object') ? res : { outcome: String(res) };

        // Current scripts return the next URL so shared pacing happens before
        // navigation. Older scripts may already have moved the page themselves.
        if (outcome.outcome === 'navigating') {
          if (outcome.country) {
            if (selectedCountry) triedCountries.push(selectedCountry);
            triedCountries.push(outcome.country);
            selectedCountry = outcome.country;
            this.access?.forgetRegion(step.service);
          }
          if (outcome.releaseUrl) {
            releaseUrl = outcome.releaseUrl;
            if (selectedCountry) this.access?.rememberRegion(step.service, selectedCountry);
          }
          if (Array.isArray(outcome.alternates)) alternates = outcome.alternates.slice();
          if (outcome.url) {
            await this.access?.pace(this.access.key(step), signal, (ms, limited) => this.onWait(item.id, step, ms, limited));
            this.view.navigate(outcome.url);
          }
          continue;
        }
        if (outcome.outcome === 'download-triggered' || /^clicked-/.test(outcome.outcome)) {
          if (releaseUrl) this.access?.rememberRelease(this.access.cacheKey(item, step), releaseUrl);
          return outcome;
        }
        if (outcome.outcome === 'invalid-country') this.access?.forgetRegion(step.service);
        if (['rate-limited', 'access-blocked', 'invalid-country'].includes(outcome.outcome)) return outcome;

        // A release page that yielded nothing. Try the next hit the search was
        // willing to accept before giving the store up.
        last = outcome;
        if (!alternates.length) return outcome;
        const href = alternates.shift();
        this.log('attempt.alternate', {
          id: item.id, service: step.service, outcome: outcome.outcome, url: href,
        });
        ready.cancel();
        ready = this._nextDomReady();
        await this.access?.pace(this.access.key(step), signal, (ms, limited) => this.onWait(item.id, step, ms, limited));
        releaseUrl = href;
        this.view.navigate(href);
      }
      return triedCountries.length && !releaseUrl ? { outcome: 'invalid-country', message: 'No working region found within the bounded retry budget' } : last;
    } finally {
      // Whatever happened, this attempt's listener must not outlive it.
      ready.cancel();
    }
  }

  // Returns a promise with a .cancel(): an attempt that ends without the page
  // ever becoming ready would otherwise leave its listener attached for the
  // life of the worker, and every later dom-ready would wake all of them.
  _nextDomReady() {
    let off = null;
    const p = new Promise((resolve) => {
      off = this.view.onDomReady(() => { if (off) off(); resolve(true); });
    });
    p.cancel = () => { if (off) { off(); off = null; } };
    return p;
  }

  // Injection can fail for a reason that has nothing to do with the track: the
  // page was still settling, or navigated again as the script went in, and
  // Electron rejects executeJavaScript when the frame goes away underneath it.
  // Burning a whole attempt on that would drop a store from the chain over a
  // timing accident, so it gets one quick second go.
  async _inject(script, timeoutMs, signal) {
    for (let tries = 0; tries < 2; tries++) {
      const res = await withTimeout(
        this.view.executeJavaScript(script).then(
          (v) => ({ ok: true, v }),
          (e) => ({ ok: false, message: e && e.message })
        ),
        timeoutMs,
        () => ({ ok: true, v: { outcome: 'timeout' } }), signal
      );
      if (res.ok) return res.v;
      if (tries === 0) { await withTimeout(new Promise(() => {}), 400, () => null, signal); continue; }
      const at = this.view.currentUrl ? this.view.currentUrl() : null;
      return { outcome: 'injection-failed', message: res.message, url: at };
    }
  }

}
