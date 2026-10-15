// The Lucida cascade.
//
// Lucida is a two-page flow: a search page listing candidate releases, then the
// release page carrying the actual download control. So this script runs twice
// per attempt - once to choose a hit and navigate, once to press the button -
// and the outcome 'navigating' is a success, not a stall.
//
// The scoring is the shared one from matching.mjs, so a hit good enough here is
// good enough on Monochrome and vice versa, and a fix to the rules lands in
// both. Previously each site carried its own copy inside a template string.

import { injectableScorer, MIN_TITLE_SCORE } from './matching.mjs';

export const LUCIDA_FIND_POLLS = 60;   // 500ms each
// A store with nothing to offer does NOT render an error - it renders the
// ordinary search scaffold with zero cards, which is indistinguishable from a
// slow one until enough polls have passed. This is the cost of that ambiguity,
// paid on every miss, so it is kept as tight as the site's render latency
// allows rather than left at the outer timeout.
export const LUCIDA_EMPTY_POLLS = 10;  // 500ms each -> 5s before calling it empty

// Read the recording label rather than the surrounding heading's UI badges.
// Keep this function free of module bindings: it also runs in the webview.
export function readLucidaTitle(el) {
  if (!el) return '';
  const label = el.querySelector('a') || el;
  const copy = label.cloneNode ? label.cloneNode(true) : label;
  if (copy !== label) {
    for (const badge of copy.querySelectorAll('.explicit, .explicit-badge, .explicit-tag, .badge, [title="Explicit"], [aria-label="Explicit"]')) badge.remove();
  }
  return (copy.textContent || copy.innerText || '').trim();
}

export function buildLucidaScript(expected, opts = {}) {
  const findPolls = opts.findPolls ?? LUCIDA_FIND_POLLS;
  const emptyPolls = opts.emptyPolls ?? LUCIDA_EMPTY_POLLS;

  return `
    new Promise((resolve) => {
${injectableScorer(expected, opts.minTitleScore ?? MIN_TITLE_SCORE)}
      const titleOf = ${readLucidaTitle.toString()};

      const EMPTY_POLLS = ${emptyPolls};
      const FIND_POLLS = ${findPolls};
      let empties = 0; // consecutive polls showing a rendered but empty result list
      let searchError = '';

      const attemptClick = () => {
        // 1. On a search results page, pick the best-matching hit - never blindly
        //    the first, which is how a search for one track used to come back
        //    with a different one that the store happened to rank higher.
        if (location.href.includes('/search')) {
          const errorEl = document.querySelector('.error, .alert-error');
          if (errorEl) {
            const errText = errorEl.innerText || '';
            // Countries are provider-specific and can change. Use the options
            // Lucida loaded for this provider instead of hard-coding a region.
            if (/invalid country/i.test(errText)) {
              searchError = errText.trim();
              const country = document.querySelector('select[name="country"]');
              if (!country || country.disabled || !country.options?.length) return false;
              const url = new URL(location.href);
              const choice = Array.from(country.options).find(o => !o.disabled && o.value && o.value !== url.searchParams.get('country'));
              if (choice) {
                url.searchParams.set('country', choice.value);
                location.href = url.href;
                resolve({ outcome: 'navigating', label: 'Search region: ' + choice.value });
              } else resolve({ outcome: 'search-unavailable', message: errText.trim() });
              return true;
            }
            if (/no results|nothing found|no tracks found/i.test(errText)) {
              resolve({ outcome: 'no-results' });
              return true;
            }
            // "uh-oh!" is the heading for every error, including backend
            // failures. It is not evidence that the catalogue lacks a track.
            resolve({ outcome: 'search-unavailable', message: errText.trim() });
            return true;
          }

          const cards = Array.from(document.querySelectorAll('.search-result'));
          if (cards.length === 0) {
            const scaffold = Array.from(document.querySelectorAll('h2'))
              .some((h) => /tracks|albums/i.test(h.innerText || ''));
            if (scaffold && ++empties >= EMPTY_POLLS) { resolve({ outcome: 'no-results' }); return true; }
            return false; // still loading - keep polling
          }
          empties = 0;

          const scored = [];
          for (const card of cards) {
            const linkEl = card.querySelector('.metadata a');
            if (!linkEl || !linkEl.href) continue;
            const titleEl = card.querySelector('.metadata h1');
            const artistEl = card.querySelector('.metadata h2');
            const title = titleOf(titleEl);
            const artist = artistEl ? artistEl.innerText.trim() : '';
            const s = score(title, artist, durationOf(card.querySelector('.duration, .track-duration, [data-duration]')));
            scored.push({ href: linkEl.href, title, artist, s, acceptable: isAcceptable(s, MIN_TITLE_SCORE) });
          }
          scored.sort((x, y) => (y.s.a - x.s.a) || (y.s.t - x.s.t) || (y.s.p - x.s.p));

          // The top few WITH their scores. This is what makes the log useful for
          // tuning the threshold later, rather than only knowing something failed.
          const candidates = scored.slice(0, 5).map((c) => ({
            title: c.title, artist: c.artist, href: c.href,
            t: Math.round(c.s.t * 100) / 100,
            p: Math.round(c.s.p * 100) / 100, a: c.s.a
          }));
          const best = scored.find((c) => c.acceptable) || null;
          const label = scored.length ? scored[0].title + ' - ' + scored[0].artist : 'none';

          if (!best) {
            resolve({ outcome: 'no-match', label, candidates, considered: scored.length });
            return true;
          }
          // Alternates are returned so a release page with no usable download
          // control can be retried against the next hit instead of failing the
          // whole store.
          const alternates = scored.filter((c) => c.acceptable && c.href !== best.href)
                                   .slice(0, 3).map((c) => c.href);
          location.href = best.href;
          resolve({ outcome: 'navigating', label: best.title + ' - ' + best.artist,
                    candidates, considered: scored.length, alternates });
          return true;
        }

        // 2. Error message on release page
        const releaseErr = document.querySelector('.error h2, .error p, .alert-error');
        if (releaseErr) {
          const errText = (releaseErr.innerText || '').trim();
          if (errText && /unavailable|backend|service error|maintenance|not found|disabled|failed/i.test(errText)) {
            resolve({ outcome: 'provider-failed', message: errText });
            return true;
          }
        }

        // Pick a track's own control before considering a page-level button.
        // Releases can contain the original, radio edit and several remixes.
        const pageArtist = document.querySelector('.metadata h2, .release-artist, .album-artist');
        const artistText = pageArtist ? (pageArtist.innerText || '').trim() : '';
        const rows = Array.from(document.querySelectorAll('.track-row, .track-item, .tracklist tr, .track-list tr, .tracks tr'));
        const controlIn = (row) => {
          const direct = row.querySelector('.download-button, button img[alt*="ownload"], button img[src*="download"]');
          if (direct) return direct.closest('button') || direct;
          return Array.from(row.querySelectorAll('button, a, div[role="button"]')).find(el =>
            /^(download|download track)$/i.test((el.innerText || el.textContent || '').trim()));
        };
        if (rows.length) {
          for (const row of rows) {
            const titleEl = row.querySelector('.title, .track-title, .track-name, h1');
            const title = titleOf(titleEl);
            const artistEl = row.querySelector('.artist, .track-artist, h2');
            const artist = artistEl ? (artistEl.innerText || '').trim() : artistText || EXPECTED.artist;
            const button = controlIn(row);
            if (!title || !button || !isAcceptable(score(title, artist, durationOf(row.querySelector('.duration, .track-duration'))), MIN_TITLE_SCORE)) continue;
            button.click(); resolve({ outcome: 'clicked-track', label: title + ' - ' + artist }); return true;
          }
          // Never fall through to an album or a different track's control.
          resolve({ outcome: 'no-match', label: 'No matching release track' }); return true;
        }
        const releaseTitle = document.querySelector('.metadata h1, .release-title');
        if (releaseTitle && !isAcceptable(score(titleOf(releaseTitle), artistText || EXPECTED.artist), MIN_TITLE_SCORE)) {
          resolve({ outcome: 'no-match', label: 'Release metadata differs' }); return true;
        }
        const buttons = Array.from(document.querySelectorAll('.download-button'));
        if (buttons.length > 1) { resolve({ outcome: 'no-match', label: 'Ambiguous release controls' }); return true; }

        // 3. Single-track page download button.
        const mainBtn = document.querySelector('.download-button');
        if (mainBtn && !/album|full/i.test(mainBtn.innerText || mainBtn.textContent || '')) { mainBtn.click(); resolve({ outcome: 'clicked-download-button' }); return true; }

        // 3. Track-level download icon.
        const iconImg = document.querySelector('button img[alt*="ownload"], button img[src*="download"]');
        if (iconImg && iconImg.closest('button')) {
          iconImg.closest('button').click();
          resolve({ outcome: 'clicked-icon' });
          return true;
        }

        // 4. Text fallbacks.
        for (const el of document.querySelectorAll('button, a, div[role="button"]')) {
          const text = (el.innerText || el.textContent || '').toLowerCase().trim();
          if (text === 'download track' || text === 'download') {
            el.click();
            resolve({ outcome: 'clicked-text' });
            return true;
          }
        }
        return false;
      };

      if (attemptClick()) return;
      let polls = 0;
      const interval = setInterval(() => {
        if (attemptClick()) { clearInterval(interval); }
        else if (++polls > FIND_POLLS) {
          clearInterval(interval);
          resolve(searchError ? { outcome: 'search-unavailable', message: searchError } : { outcome: 'timeout' });
        }
      }, 500);
    });
  `;
}
