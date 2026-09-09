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
import { pickYouTube } from './yt-fallback.mjs';
import { SOURCE_LUCIDA, SOURCE_MONOCHROME, SOURCE_JAMENDO, SOURCE_SOUNDCLOUD, SOURCE_YOUTUBE, SOURCE_DIRECT } from './chain.mjs';

export const DEFAULTS = {
  domReadyTimeoutMs: 45000,
  cascadeTimeoutMs: 90000,
  monochromeCascadeTimeoutMs: 240000,
  downloadStartTimeoutMs: 120000,
};

export function lucidaSearchUrl(query, service) {
  return `https://lucida.to/search?query=${encodeURIComponent(query)}&service=${service}`;
}

export function monochromeSearchUrl(query) {
  return `https://monochrome.tf/search/${encodeURIComponent(query)}`;
}

export function urlForStep(step) {
  if (step.source === SOURCE_MONOCHROME) return monochromeSearchUrl(step.query);
  return lucidaSearchUrl(step.query, step.service);
}

class Aborted extends Error {
  constructor() { super('aborted'); this.name = 'Aborted'; }
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve(onTimeout()), ms); }),
  ]);
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
    const cancel = () => this.ipc.cancelDownload?.(item.id);
    signal?.addEventListener("abort", cancel, { once: true });

    try {
      const result = await this._dispatch(item, step, signal);
      this.log('attempt.outcome', {
        id: item.id, name: item.name, service: step.service,
        outcome: result.outcome, label: result.label || null,
        message: result.message || null, url: result.url || null,
        ms: Date.now() - started,
      });
      return { ...base, ...result };
    } catch (err) {
      if (err instanceof Aborted) throw err;
      this.log('attempt.error', { id: item.id, service: step.service, message: err.message });
      return { ...base, outcome: 'error', message: err.message };
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  _dispatch(item, step, signal) {
    switch (step.source) {
      case SOURCE_DIRECT:     return this._runDirect(item, step, signal);
      case SOURCE_JAMENDO:    return this._runJamendo(item, step, signal);
      case SOURCE_SOUNDCLOUD: return this._runMediaSearch(item, step, signal, 'soundcloud');
      case SOURCE_YOUTUBE:    return this._runMediaSearch(item, step, signal, 'youtube');
      default:                return this._runScraped(item, step, signal);
    }
  }

  // Jamendo exposes direct FLAC download URLs through its official API, but
  // only when the artist has enabled downloads. The main process performs that
  // filtering; this side still applies the ordinary title/artist/duration gate
  // with stricter thresholds because a wrong free track is not a fallback.
  async _runJamendo(item, step, signal) {
    const search = await this.ipc.searchJamendo(step.query, 10);
    if (signal && signal.aborted) throw new Aborted();

    const res = Array.isArray(search) ? { ok: true, results: search } : (search || { ok: false, results: [] });
    if (!res.ok) {
      return {
        outcome: 'search-unavailable',
        message: res.reason === 'not-configured'
          ? 'add a Jamendo client ID in Settings'
          : (res.message || res.reason || 'search unavailable'),
      };
    }
    if (!res.results?.length) return { outcome: 'no-results' };

    const { chosen, ranked } = pickYouTube(
      { title: item.title, artist: item.artist, durationSec: item.durationSec },
      res.results,
      { minTitleScore: 1, maxDriftSec: 8 }
    );
    if (!chosen) {
      const top = ranked[0];
      return { outcome: 'no-match', label: top?.title || null, message: top?.reason || null };
    }

    const done = await this.ipc.downloadYouTube({
      url: chosen.url,
      service: SOURCE_JAMENDO,
      itemId: item.id,
      key: item.key,
      folderName: item.folderName,
      title: item.title,
      artist: item.artist,
      group: item.groupName || null,
      sourcePage: chosen.sourcePage || null,
      licenseUrl: chosen.licenseUrl || null,
    });
    if (signal && signal.aborted) throw new Aborted();
    return {
      outcome: 'completed', label: `${chosen.artist} — ${chosen.title}`,
      via: 'jamendo-api', savePath: done?.savePath, file: done?.file, bytes: done?.bytes,
    };
  }

  async _runScraped(item, step, signal) {
    const url = urlForStep(step);
    const isMono = step.source === SOURCE_MONOCHROME;

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
      group: item.groupName || null,
      service: step.service,
      attemptService: step.service,
      originalService: item.originalService || step.service,
      sourceUrl: url,
    });

    try {
      const outcome = await this._navigateAndInject(item, step, url, isMono, signal);
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
    }
  }

  // Lucida is a two-page flow - search, then the release page - so a
  // 'navigating' outcome means "run again on the page it just went to".
  async _navigateAndInject(item, step, url, isMono, signal) {
    const expected = { title: item.title, artist: item.artist };
    const build = isMono ? buildMonochromeScript : buildLucidaScript;
    const cascadeMs = isMono ? this.t.monochromeCascadeTimeoutMs : this.t.cascadeTimeoutMs;

    // Armed before navigating so the event cannot land in the gap between the
    // call and the listener.
    let ready = this._nextDomReady();
    this.view.navigate(url);

    try {
      for (let hop = 0; hop < 2; hop++) {
        if (signal && signal.aborted) throw new Aborted();
        const arrived = await withTimeout(ready, this.t.domReadyTimeoutMs, () => null);
        if (arrived === null) return { outcome: 'navigation-timeout' };

        // Re-arm BEFORE injecting. The search cascade navigates by assigning
        // location.href from inside the page, so the release page's dom-ready
        // can fire before the injected promise even resolves; arming afterwards
        // would miss it on a fast load and stall until the navigation timeout.
        ready.cancel();
        ready = this._nextDomReady();

        const res = await this._inject(build(expected, {}), cascadeMs);
        const outcome = (res && typeof res === 'object') ? res : { outcome: String(res) };

        // 'navigating' means the page moved itself to the release page; loop
        // round and run the cascade again there. No navigate() - it already went.
        if (outcome.outcome === 'navigating') continue;
        return outcome;
      }
      return { outcome: 'navigation-exhausted' };
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
  async _inject(script, timeoutMs) {
    for (let tries = 0; tries < 2; tries++) {
      const res = await withTimeout(
        this.view.executeJavaScript(script).then(
          (v) => ({ ok: true, v }),
          (e) => ({ ok: false, message: e && e.message })
        ),
        timeoutMs,
        () => ({ ok: true, v: { outcome: 'timeout' } })
      );
      if (res.ok) return res.v;
      if (tries === 0) { await new Promise((r) => setTimeout(r, 400)); continue; }
      const at = this.view.currentUrl ? this.view.currentUrl() : null;
      return { outcome: 'injection-failed', message: res.message, url: at };
    }
  }

  // The track came in with the URL of a specific upload - there is nothing to
  // search for and nothing to score, because the user already told us which
  // recording they meant. A failure here is not a verdict on the track, so it
  // falls through to the ordinary chain rather than ending it.
  async _runDirect(item, step, signal) {
    const url = step.url || item.mediaUrl;
    if (!url) return { outcome: 'no-results' };
    try {
      const done = await this.ipc.downloadYouTube({
        url,
        service: step.service || SOURCE_SOUNDCLOUD,
        itemId: item.id,
        key: item.key,
        folderName: item.folderName,
        title: item.title,
        artist: item.artist,
        group: item.groupName || null,
      });
      if (signal && signal.aborted) throw new Aborted();
      return {
        outcome: 'completed', label: item.name || item.title, via: 'yt-dlp',
        savePath: done && done.savePath, file: done && done.file, bytes: done && done.bytes,
      };
    } catch (err) {
      if (err instanceof Aborted) throw err;
      return { outcome: 'direct-failed', message: err && err.message };
    }
  }

  /**
   * A yt-dlp-backed search source: YouTube or SoundCloud. Both answer every
   * query with SOMETHING, which is exactly why the scorer gates them - see
   * yt-fallback.mjs. The two differ only in which search yt-dlp is asked to run
   * and how a failure reads to the user, so they share this.
   */
  async _runMediaSearch(item, step, signal, kind) {
    const search = kind === 'soundcloud'
      ? await this.ipc.searchSoundCloud(step.query, 5)
      : await this.ipc.searchYouTube(step.query, 5);
    if (signal && signal.aborted) throw new Aborted();

    // Older shape (a bare array) is still accepted so this keeps working if the
    // main process has not been updated.
    const res = Array.isArray(search) ? { ok: true, results: search } : (search || { ok: false, results: [] });
    if (!res.ok) {
      // The search never happened. Saying 'no-results' here would record "not
      // on SoundCloud/YouTube" for a track nobody actually looked for.
      return { outcome: 'search-unavailable', message: res.message || res.reason || 'search unavailable' };
    }
    const candidates = res.results || [];
    if (!candidates.length) return { outcome: 'no-results' };

    const { chosen, ranked } = pickYouTube(
      { title: item.title, artist: item.artist, durationSec: item.durationSec },
      candidates
    );
    if (!chosen) {
      const top = ranked[0];
      return { outcome: 'no-match', label: top ? top.title : null, message: top ? top.reason : null };
    }

    const done = await this.ipc.downloadYouTube({
      url: chosen.url,
      service: kind,
      itemId: item.id,
      key: item.key,
      folderName: item.folderName,
      title: item.title,
      artist: item.artist,
      group: item.groupName || null,
    });
    return { outcome: 'completed', label: chosen.title, via: 'yt-dlp', savePath: done && done.savePath, file: done && done.file, bytes: done && done.bytes };
  }
}
