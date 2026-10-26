// Adapters between the engine's plain interfaces and Electron's primitives.
//
// The engine deliberately knows nothing about webviews or ipcRenderer - that is
// what lets the whole attempt flow be tested in Node. Everything Electron-shaped
// lives here.

/**
 * Wrap a <webview> element as the view interface Worker expects.
 *
 * The webview's own webContents id is what the main process keys a pending
 * download context by, so it must be read once the element is attached.
 */
export function viewAdapter(webview) {
  return {
    get webContentsId() {
      try { return webview.getWebContentsId(); } catch (e) { return null; }
    },
    navigate(url) {
      // Re-assigning the same src does not reload, and a retry against the same
      // URL is normal (a variant that resolves to an identical query).
      if (webview.getAttribute('src') === url) webview.reload();
      else webview.setAttribute('src', url);
    },
    reset() { webview.setAttribute('src', 'about:blank'); },
    onDomReady(cb) {
      // A worker webview has to be created with a src to attach at all, so its
      // FIRST dom-ready is for about:blank. Passing that on makes the worker
      // think the search page has arrived and inject into a blank document that
      // is already navigating away - which tears the script down mid-execution
      // and surfaces as 'injection-failed' on the first attempt of every worker.
      const guarded = () => {
        let url = '';
        try { url = webview.getURL(); } catch (e) { /* not attached yet */ }
        if (!url || url === 'about:blank') return;
        cb();
      };
      webview.addEventListener('dom-ready', guarded);
      return () => webview.removeEventListener('dom-ready', guarded);
    },
    executeJavaScript(src) {
      return webview.executeJavaScript(src);
    },
    // Where the page actually ended up. On an injection failure this is the only
    // way to tell "the site redirected us" (a bot check, an error page) from
    // "the frame went away", and the two need completely different responses.
    currentUrl() {
      try { return webview.getURL(); } catch (e) { return null; }
    },
  };
}

/**
 * Tracks downloads by item so a worker can await its own file.
 *
 * The main process announces a start with an itemId but reports completion
 * against a filename, so the two have to be stitched together here. With one
 * download at a time that mapping was implicit; with several in flight it is
 * the only thing keeping two tracks' completions apart.
 */
export class DownloadTracker {
  constructor(ipcRenderer, { startTimeoutMs = 120000, earlyCap = 200 } = {}) {
    this.earlyCap = earlyCap;
    this.byFile = new Map();     // filename -> itemId
    this.waiters = new Map();    // itemId -> { resolve, timer, started }
    // Results that arrived before anyone asked for them. The worker only calls
    // await() once the injected click has returned, but the main process fires
    // as soon as Chromium does - so a quick transfer can be wholly over before
    // the waiter exists. Dropping it there would leave the track waiting out the
    // full start timeout and then reporting a download that in fact succeeded.
    this.early = new Map();      // itemId -> settled value
    // A transfer has two moments worth waiting for, and the pipeline needs them
    // apart: the click became a real download (the webview is free from here
    // on) and the file landed. `await()` still spans both for callers that only
    // care about the end.
    this.startWaiters = new Map(); // itemId -> { resolve, timer }
    this.started = new Set();      // itemIds whose download-started has arrived
    this.startTimeoutMs = startTimeoutMs;
    this._ipc = ipcRenderer;
    this._handlers = new Map();
    const on = (channel, handler) => {
      this._handlers.set(channel, handler);
      ipcRenderer.on(channel, handler);
    };

    on('download-started', (event, payload) => {
      const { file, itemId } = payload || {};
      if (!itemId) return;
      if (file) this.byFile.set(file, itemId);
      this.started.add(itemId);
      const w = this.waiters.get(itemId);
      if (w) {
        w.started = true;
        // The start deadline is done with; the transfer itself has no deadline
        // here because the main process reports its own failures.
        clearTimeout(w.timer);
        w.timer = null;
      }
      const sw = this.startWaiters.get(itemId);
      if (sw) {
        this.startWaiters.delete(itemId);
        clearTimeout(sw.timer);
        sw.resolve(payload || { itemId });
      }
      if (this.onStarted) this.onStarted(itemId, payload);
    });

    // Bytes are reported against a filename, so this needs the same stitching
    // as completion does.
    on('download-progress', (event, payload) => {
      const { file, received, total } = payload || {};
      const itemId = this._idFor(payload, file);
      if (itemId && this.onProgress) this.onProgress(itemId, received || 0, total || 0);
    });

    // A yt-dlp transfer (the SoundCloud and YouTube stages, and a pasted
    // upload) is not a Chromium download: there is no DownloadItem and no
    // filename to stitch through, and its caller is awaiting the invoke rather
    // than a waiter here. So it reports on its own channels, carries the itemId
    // throughout, and deliberately never settles a waiter - a completion posted
    // to 'download-status' would be filed as an unclaimed result and handed to
    // whatever attempt asked next.
    on('media-download-started', (event, payload) => {
      const { itemId } = payload || {};
      if (itemId && this.onStarted) this.onStarted(itemId, payload);
    });

    on('media-download-progress', (event, payload) => {
      const { itemId, received, total } = payload || {};
      if (itemId && this.onProgress) this.onProgress(itemId, received || 0, total || 0);
    });

    on('download-status', (event, payload) => {
      const { file, status, savePath, bytes, service } = payload || {};
      const itemId = this._idFor(payload, file);
      if (!itemId) return;
      if (file && this.byFile.get(file) === itemId) this.byFile.delete(file);
      this._settle(itemId, { status, savePath, file, bytes, service });
    });
  }

  /**
   * Which track an event belongs to.
   *
   * The itemId the main process carries is authoritative; the filename index is
   * only a fallback for an older main process that does not send one. A
   * filename is NOT unique - two tracks downloading files of the same name in
   * different folders overwrite each other's entry - and the loser of that race
   * used to be handed the winner's completion while its own attempt waited out
   * the full start timeout and then reported a download that had in fact
   * succeeded.
   */
  _idFor(payload, file) {
    if (payload && payload.itemId) return payload.itemId;
    return file ? this.byFile.get(file) || null : null;
  }

  _settle(itemId, value) {
    this.started.delete(itemId);
    // Rejections may finish before Chromium announces a start.
    const sw = this.startWaiters.get(itemId);
    if (sw) {
      this.startWaiters.delete(itemId);
      clearTimeout(sw.timer);
      sw.resolve({ itemId });
    }
    const w = this.waiters.get(itemId);
    if (!w) { this._holdEarly(itemId, value); return; } // held until await() asks
    this.waiters.delete(itemId);
    if (w.timer) clearTimeout(w.timer);
    w.resolve(value);
  }

  /**
   * A result nobody has asked for yet.
   *
   * Bounded, because not every one of these is ever collected: an attempt that
   * has already moved on never calls await(), and over a multi-hour run those
   * accumulate. Oldest out first - a stale result is worth less than a fresh
   * one, and the waiter for it is long gone.
   */
  _holdEarly(itemId, value) {
    this.early.set(itemId, value);
    while (this.early.size > this.earlyCap) {
      const oldest = this.early.keys().next().value;
      if (oldest === undefined) break;
      this.early.delete(oldest);
    }
  }

  /**
   * Resolves once the click has become a real transfer, or null if it never
   * did. Past this point the file is the main process's business and the
   * webview that started it is free to go and search something else.
   */
  awaitStart(itemId, signal) {
    if (signal?.aborted) return Promise.resolve(null);
    if (this.started.has(itemId) || this.early.has(itemId)) return Promise.resolve({ itemId });
    return this._wait(this.startWaiters, itemId, signal, false);
  }

  /** Resolves with the finished download, or null if none ever started. */
  await(itemId, signal) {
    if (signal?.aborted) return Promise.resolve(null);
    // Already finished while the click was still returning.
    if (this.early.has(itemId)) {
      const value = this.early.get(itemId);
      this.early.delete(itemId);
      return Promise.resolve(value);
    }
    return this._wait(this.waiters, itemId, signal, this.started.has(itemId));
  }

  _wait(map, itemId, signal, started) {
    // Replacing a wait must release the old promise, not orphan it forever.
    map.get(itemId)?.resolve(null);
    return new Promise((resolve) => {
      const abort = () => waiter.resolve(null);
      const waiter = {
        started, timer: null,
        resolve: (value) => {
          if (map.get(itemId) === waiter) map.delete(itemId);
          clearTimeout(waiter.timer);
          signal?.removeEventListener('abort', abort);
          resolve(value);
        },
      };
      map.set(itemId, waiter);
      if (!started) waiter.timer = setTimeout(() => waiter.resolve(null), this.startTimeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  dispose() {
    for (const [channel, handler] of this._handlers) this._ipc.removeListener?.(channel, handler);
    this._handlers.clear();
    for (const waiter of [...this.waiters.values(), ...this.startWaiters.values()]) waiter.resolve(null);
    this.byFile.clear();
    this.started.clear();
    this.early.clear();
    this.onStarted = null;
    this.onProgress = null;
  }
}

export function ipcAdapter(ipcRenderer, tracker) {
  return {
    onSourceResponse(webContentsId, itemId, cb) {
      const handler = (_event, response) => {
        if (response?.webContentsId === webContentsId && response.itemId === itemId) cb(response);
      };
      ipcRenderer.on('source-response', handler);
      return () => ipcRenderer.removeListener('source-response', handler);
    },
    setDownloadContext(ctx) { ipcRenderer.send('set-next-download-folder', ctx); },
    clearDownloadContext(id) { ipcRenderer.send('clear-download-context', id); },
    awaitDownload(itemId, signal) { return tracker.await(itemId, signal); },
    awaitDownloadStart(itemId, signal) { return tracker.awaitStart(itemId, signal); },
    cancelDownload(itemId) { ipcRenderer.send('download-cancel-item', itemId); },
    listResumableTransfers() { return ipcRenderer.invoke('transfers-resumable'); },
    resumeTransfer(itemId) { return ipcRenderer.invoke('transfer-resume', itemId); },
  };
}

/**
 * Create (or reuse) the worker webviews. One per concurrent slot: two tracks
 * driving the same page would interleave their scrapes and their downloads.
 */
export function ensureWorkerViews(container, count, { partition } = {}) {
  const views = [...container.querySelectorAll('webview.worker-view')];
  while (views.length < count) {
    const wv = document.createElement('webview');
    wv.className = 'worker-view';
    wv.setAttribute('src', 'about:blank');
    if (partition) wv.setAttribute('partition', partition);
    // Offscreen but still rendered: a display:none webview does not lay out or
    // run its page, and the cascades depend on the page actually running.
    wv.style.cssText = 'position:absolute; z-index:-1; opacity:0.001; pointer-events:none; width:1024px; height:768px;';
    container.appendChild(wv);
    views.push(wv);
  }
  return views.slice(0, count);
}
