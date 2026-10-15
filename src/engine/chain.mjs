// Download attempts use only explicitly enabled FLAC sources.

export const SOURCE_LUCIDA = 'lucida';
export const SOURCE_MONOCHROME = 'monochrome';
export const SOURCE_SOUNDCLOUD = 'soundcloud';
export const SOURCE_YOUTUBE = 'youtube';
// Retained to identify and reject direct-upload attempts from older queues.
export const SOURCE_DIRECT = 'direct';

export const DEFAULT_MAX_VARIANTS = 2;

export const DOWNLOAD_SERVICES = ['qobuz', 'tidal', 'deezer', 'amazon', 'yandex', 'monochrome'];

export function buildPlan(spec = {}) {
  const used = (spec.variants || []).filter(Boolean)
    .slice(0, Math.max(1, spec.maxVariantsPerSource ?? DEFAULT_MAX_VARIANTS));
  if (!used.length) return [];
  const plan = [];
  for (const service of new Set(spec.services || [])) {
    if (!DOWNLOAD_SERVICES.includes(service)) continue;
    used.forEach((query, variantIndex) => plan.push({
      source: service === SOURCE_MONOCHROME ? SOURCE_MONOCHROME : SOURCE_LUCIDA,
      service, query, variantIndex,
    }));
  }
  return plan;
}

/**
 * The next attempt to make, skipping stores currently known to be down and any
 * source the track has already exhausted.
 *
 * @param plan     from buildPlan
 * @param progress { index, skip?: Set|string[] } - skip names unhealthy services
 */
export function nextAttempt(plan, progress = {}) {
  const skip = progress.skip instanceof Set ? progress.skip : new Set(progress.skip || []);
  for (let i = progress.index || 0; i < plan.length; i++) {
    const step = plan[i];
    if (skip.has(step.service)) continue;
    return { ...step, index: i };
  }
  return null;
}

// A failure on one search does not always mean the rest of that store is
// pointless. "no results" for a query is worth rephrasing; the store being
// unreachable is not, and neither is a confident rejection of every card.
export function advanceAfter(plan, index, outcome) {
  const step = plan[index];
  if (!step) return plan.length;
  switch (outcome) {
    case 'no-results':
    case 'no-match':
      return index + 1; // try the next variant, then the next store
    // 'service-unavailable' is the name this was written against; nothing ever
    // emitted it. The worker says 'search-unavailable' when the search never
    // happened, and 'navigation-timeout' when the store's page never arrived -
    // both mean the same thing here, and while they were missing from this list
    // every one of them fell through to `default` and re-asked a dead store
    // under a differently worded query.
    case 'service-unavailable':
    case 'search-unavailable':
    case 'navigation-timeout':
    case 'provider-failed':
      // Skip this source's remaining variants: a store that cannot serve the
      // track will not serve it under a differently worded query either.
      for (let i = index + 1; i < plan.length; i++) {
        if (plan[i].service !== step.service) return i;
      }
      return plan.length;
    default:
      return index + 1;
  }
}
