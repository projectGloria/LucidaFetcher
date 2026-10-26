// Observe only requests belonging to a worker's current attempt. Bind at request
// start so a late response from the previous track cannot poison its successor.
function installSourceObserver(webRequest, getContext, publish) {
  const requests = new Map();
  webRequest.onBeforeSendHeaders((details, callback) => {
    const ctx = getContext(details.webContentsId);
    if (ctx && ['mainFrame', 'xhr'].includes(details.resourceType)) {
      try {
        const url = new URL(details.url);
        const page = new URL(ctx.sourceUrl);
        const same = url.origin === page.origin;
        const lucida = /(^|\.)lucida\.to$/.test(page.hostname) && /(^|\.)lucida\.to$/.test(url.hostname);
        const mono = page.hostname === 'monochrome.st' && /(^|\.)monochrome\.(st|tf)$/.test(url.hostname);
        const custom = ctx.apiUrl && url.origin === new URL(ctx.apiUrl).origin;
        if (same || lucida || mono || custom) requests.set(details.id, { ctx, host: url.host });
      } catch { /* not an HTTP source */ }
    }
    callback({});
  });
  webRequest.onHeadersReceived((details, callback) => {
    const tracked = requests.get(details.id);
    if (tracked && getContext(details.webContentsId) === tracked.ctx && details.statusCode >= 400) {
      const header = Object.entries(details.responseHeaders || {}).find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
      publish({ webContentsId: details.webContentsId, itemId: tracked.ctx.itemId,
        service: tracked.ctx.service, host: tracked.host, status: details.statusCode,
        mainFrame: details.resourceType === 'mainFrame',
        retryAfter: header == null ? null : String(Array.isArray(header) ? header[0] : header).slice(0, 128) });
    }
    callback({});
  });
  webRequest.onCompleted(details => requests.delete(details.id));
  webRequest.onErrorOccurred(details => requests.delete(details.id));
}

module.exports = { installSourceObserver };
