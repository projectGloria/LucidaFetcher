import { DOWNLOAD_SERVICES } from './chain.mjs';

// Metadata services identify the imported track; they do not supply its audio.
// Legacy downloads can still have a proven YouTube/SoundCloud source.
const downloadProvider = service => DOWNLOAD_SERVICES.includes(service) || ['youtube', 'soundcloud'].includes(service);

// Only the current provider is shown while working; completion keeps the winner.
export function displayedService(rec) {
  if (!rec) return null;
  if (rec.status === 'completed') {
    const known = [rec.transferService, rec.result?.service, rec.result?.step?.service, rec.step?.service, rec.item?.transferService].find(downloadProvider);
    if (known) return known;
    for (let i = (rec.tried?.length || 0) - 1; i >= 0; i--) {
      const attempt = rec.tried[i];
      if (attempt.outcome === 'completed' && downloadProvider(attempt.service)) return attempt.service;
    }
    return null;
  }
  if (rec.status === 'ready' || rec.status === 'downloading') {
    return [rec.transferService, rec.step?.service].find(downloadProvider) || null;
  }
  if (rec.status === 'searching') {
    return rec.step?.service || null;
  }
  return null;
}
