// The download engine, as one import.
//
// Nothing in here touches the DOM of the app's own window, React, or Electron
// except through electron-bridge.mjs, so the whole thing runs and is tested in
// plain Node.

export * from './matching.mjs';
export * from './variants.mjs';
export * from './chain.mjs';
export * from './status.mjs';
export { Pool } from './pool.mjs';
export { Worker, urlForStep, lucidaSearchUrl, monochromeSearchUrl } from './worker.mjs';
export { buildLucidaScript } from './cascade-lucida.mjs';
export { buildMonochromeScript } from './cascade-monochrome.mjs';
export { rankYouTube, pickYouTube, cleanYouTubeTitle } from './yt-fallback.mjs';
export {
  Controller, QUEUED, SEARCHING, DOWNLOADING, COMPLETED, SKIPPED, CANCELLED,
} from './controller.mjs';
export {
  viewAdapter, ipcAdapter, DownloadTracker, ensureWorkerViews,
} from './electron-bridge.mjs';
export { startEngine, DEFAULT_CONCURRENCY } from './renderer-integration.mjs';

export { collectProfiles, reportPayload, profileSignature } from './profile-report.mjs';
