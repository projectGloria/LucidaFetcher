// Human-readable descriptions of what the engine is doing and why.
//
// The old UI said "Fetching..." for every state between queued and finished,
// and "Skipped" with a reason assembled ad hoc at each call site. Neither told
// the user which store was being asked, how far through the chain a track was,
// or whether a skip meant "nobody has it" or "the site broke". Descriptions
// live here, next to the outcomes they describe, so the engine and every view
// agree on the wording and it can be changed in one place.

import { SOURCE_LUCIDA, SOURCE_MONOCHROME, SOURCE_SOUNDCLOUD, SOURCE_YOUTUBE, SOURCE_DIRECT } from './chain.mjs';

export const SERVICE_LABELS = {
  qobuz: 'Qobuz', tidal: 'Tidal', amazon: 'Amazon Music', deezer: 'Deezer',
  soundcloud: 'SoundCloud', spotify: 'Spotify', napster: 'Napster', yandex: 'Yandex Music',
  monochrome: 'Monochrome', youtube: 'YouTube',
  'hifi-tidal': 'HiFi Tidal', 'squid-qobuz': 'Squid Qobuz',
};

export function serviceLabel(service) {
  return SERVICE_LABELS[service] || (service ? service[0].toUpperCase() + service.slice(1) : 'Unknown');
}

/** "Searching Qobuz" / "Searching Qobuz (wording 2 of 2)" */
export function describeStep(step, plan) {
  if (!step) return 'Waiting';
  const label = serviceLabel(step.service);
  const sameSource = (plan || []).filter((s) => s.service === step.service);
  const nth = sameSource.findIndex((s) => s.variantIndex === step.variantIndex) + 1;
  const suffix = sameSource.length > 1 && nth > 1 ? ` (wording ${nth} of ${sameSource.length})` : '';

  if (step.source === SOURCE_DIRECT) return `Fetching the ${label} upload this track came from`;
  if (step.source === SOURCE_SOUNDCLOUD) return 'Searching SoundCloud';
  if (step.source === SOURCE_YOUTUBE) return 'Last resort: searching YouTube';
  if (step.source === SOURCE_MONOCHROME) return `Searching ${label}${suffix}`;
  if (step.source === SOURCE_LUCIDA) return `Searching ${label} via Lucida${suffix}`;
  return `Searching ${label}${suffix}`;
}

// Why one attempt did not produce a file, in the user's terms rather than the
// cascade's. `label` is the best hit the site offered, which is the single most
// useful thing to show when a match was refused.
export function describeOutcome(outcome, ctx = {}) {
  const label = ctx.label ? ` — best hit was "${ctx.label}"` : '';
  const service = serviceLabel(ctx.service);
  switch (outcome) {
    case 'completed': return 'Downloaded';
    case 'no-results': return `${service} has no results for this search`;
    case 'no-match': return `${service} had nothing matching this track${label}`;
    case 'provider-failed': return `${service} found it but could not supply the audio${ctx.message ? ` (${ctx.message})` : ''}`;
    case 'no-download-started': return `${service} accepted the download but never sent a file`;
    case 'download-failed': {
      if (ctx.message === 'rejected-track-identity')
        return `The file from ${service} was a different recording — trying another source`;
      if (ctx.message === 'rejected-no-artwork')
        return `The file from ${service} had no embedded artwork — skipped`;
      return `The transfer from ${service} failed (${ctx.message || 'interrupted'})`;
    }
    case 'navigation-timeout': return `${service} did not load in time`;
    case 'timeout': return `${service} stopped responding while preparing the file`;
    case 'injection-failed': return `Lost the connection to the ${service} page`;
    case 'no-download-control': return `${service} offered no download option for this track`;
    case 'direct-failed': return `Could not fetch the ${service} upload directly${ctx.message ? ` (${ctx.message})` : ''}`;
    case 'rate-limited': return `${service} is limiting requests — retry after the cooldown`;
    case 'access-blocked': return `${service} denied access (HTTP 403)`;
    case 'invalid-country': return `${service} rejected the available search regions`;
    case 'search-unavailable': return `Could not search ${service}${ctx.message ? ` — ${ctx.message}` : ' — the source is unavailable'}`;
    case 'error': return `${service} failed: ${ctx.message || 'unknown error'}`;
    default: return `${service}: ${outcome}`;
  }
}

/** Why a track was abandoned, given everything that was tried. */
export function describeAbandon(tried = []) {
  if (!tried.length) return 'Nothing was tried — no search query could be built';
  const specific = tried.find(t => ['rate-limited', 'access-blocked', 'invalid-country'].includes(t.outcome));
  if (specific) return describeOutcome(specific.outcome, specific);
  const providerFailed = tried.filter((t) => t.outcome === 'provider-failed');
  const nothingHadIt = tried.every((t) => t.outcome === 'no-results' || t.outcome === 'no-match');

  // A source that could not be REACHED never gave an answer, so the track was
  // not actually ruled out - and saying so matters, because it means retrying
  // later is worth doing rather than pointless.
  const unreachable = tried.filter((t) => t.outcome === 'search-unavailable' || t.outcome === 'navigation-timeout');
  if (unreachable.length) {
    const names = [...new Set(unreachable.map((t) => serviceLabel(t.service)))].join(', ');
    return `Could not search ${names} — the source failed or did not respond; retry later`;
  }

  if (nothingHadIt) {
    return `Not found on any of ${tried.length} source${tried.length > 1 ? 's' : ''} (${tried.map((t) => serviceLabel(t.service)).join(', ')})`;
  }
  if (providerFailed.length) {
    return `Found on ${providerFailed.map((t) => serviceLabel(t.service)).join(', ')} but no source could supply the audio`;
  }
  return `Failed on all ${tried.length} sources tried`;
}
