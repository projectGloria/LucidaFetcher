// The order of attempts for one track, as data.
//
// The old code decided this incrementally and in several places at once:
// handleNoStart counted attempts, tryFallbackOrAbandon picked the next store,
// startMonochromeAttempt special-cased the site swap, and tryNextSearchVariant
// rewound the counters. Each of them mutated the item and re-queued it, so the
// real order of attempts existed nowhere you could read it - and nowhere you
// could test it. Building the whole plan up front makes it inspectable, lets
// the UI say what will be tried next, and turns a fallback into an index bump.
//
// DEPTH. The plan is deliberately shallower than the old behaviour, which would
// try every search variant against every store before giving up. That was
// expensive precisely when it was least likely to work: a track missing from
// Qobuz is rarely found by rephrasing the query a third time, and each retry
// costs a full page load of a heavy SPA. Now that the chain ends in a YouTube
// fallback that reliably resolves this kind of catalogue, the right shape is a
// quick pass over each store and then out - fewer attempts per store, more
// stores, terminal fallback last. That makes failures both faster and more
// likely to end in a file.

export const SOURCE_LUCIDA = 'lucida';
export const SOURCE_MONOCHROME = 'monochrome';
export const SOURCE_JAMENDO = 'jamendo';
export const SOURCE_SOUNDCLOUD = 'soundcloud';
export const SOURCE_YOUTUBE = 'youtube';
// Not a search at all: the track arrived with the URL of the exact upload it
// came from (a pasted SoundCloud set), so the first thing worth trying is that
// file rather than a query that can only ever be a worse guess at it.
export const SOURCE_DIRECT = 'direct';

export const DEFAULT_MAX_VARIANTS = 2;

/**
 * @param spec {
 *   variants:  string[]   search queries, best first
 *   services:  string[]   Lucida store chain, in order
 *   monochrome:boolean    include the Monochrome stage (default true)
 *   jamendo:   boolean    include the authorized free Jamendo stage
 *   soundcloud:boolean    include the SoundCloud search stage (default true)
 *   directUrl: string     an exact upload to fetch before searching anything
 *   youtube:   boolean    include the terminal yt-dlp stage (default true)
 *   maxVariantsPerSource: number
 * }
 * @returns attempt descriptors: { source, service, query, variantIndex }
 */
export function buildPlan(spec = {}) {
  const variants = (spec.variants || []).filter(Boolean);
  if (!variants.length) return [];
  const cap = Math.max(1, spec.maxVariantsPerSource ?? DEFAULT_MAX_VARIANTS);
  const used = variants.slice(0, cap);
  const plan = [];

  if (spec.directUrl) {
    plan.push({
      source: SOURCE_DIRECT, service: spec.directService || SOURCE_SOUNDCLOUD,
      query: used[0], variantIndex: 0, url: spec.directUrl,
    });
  }

  // Jamendo is an artist-authorized, Creative Commons catalogue. It gets one
  // strict search before the broker-backed stores: more wording variants would
  // consume the user's API allowance while making a false match more likely.
  // It is opt-in because every application must use its own Jamendo client ID.
  if (spec.jamendo === true) {
    plan.push({ source: SOURCE_JAMENDO, service: SOURCE_JAMENDO, query: used[0], variantIndex: 0 });
  }

  // Lucida's own SoundCloud store is dropped when the native stage is present:
  // both would carry the service id 'soundcloud', and advanceAfter() skips
  // BY SERVICE - so a dead Lucida store would take the working native source
  // down with it. The native one is the better of the two anyway; it reads the
  // upload directly rather than through a broker that rarely answers for it.
  const nativeSoundcloud = spec.soundcloud !== false;
  for (const service of spec.services || []) {
    if (nativeSoundcloud && service === SOURCE_SOUNDCLOUD) continue;
    used.forEach((query, variantIndex) => {
      plan.push({ source: SOURCE_LUCIDA, service, query, variantIndex });
    });
  }

  if (spec.monochrome !== false) {
    // Monochrome gets the same variant budget as a store. Its cascade already
    // walks several cards per search, but that only helps once the search has
    // found the track at all, and the wording genuinely decides that here: the
    // KAN run's "Dark Essence" is listed as "Dark Essence (feat. Tsunca)", which
    // the full-credits query misses and the lead-artist query finds.
    used.forEach((query, variantIndex) => {
      plan.push({ source: SOURCE_MONOCHROME, service: SOURCE_MONOCHROME, query, variantIndex });
    });
  }

  // SoundCloud before YouTube: for the electronic catalogue this app is mostly
  // pointed at, the original upload is far more often on SoundCloud, and it is
  // an audio host rather than a video one - so its results need less rescuing
  // from mixes, live sets and "slowed + reverb" re-uploads.
  if (nativeSoundcloud) {
    plan.push({ source: SOURCE_SOUNDCLOUD, service: SOURCE_SOUNDCLOUD, query: used[0], variantIndex: 0 });
  }

  if (spec.youtube !== false) {
    plan.push({ source: SOURCE_YOUTUBE, service: SOURCE_YOUTUBE, query: used[0], variantIndex: 0 });
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
    case 'service-unavailable':
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
