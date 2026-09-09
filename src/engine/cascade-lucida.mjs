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

export function buildLucidaScript(expected, opts = {}) {
  const findPolls = opts.findPolls ?? LUCIDA_FIND_POLLS;
  const emptyPolls = opts.emptyPolls ?? LUCIDA_EMPTY_POLLS;

  return `
    new Promise((resolve) => {
${injectableScorer(expected, opts.minTitleScore ?? MIN_TITLE_SCORE)}

      const EMPTY_POLLS = ${emptyPolls};
      const FIND_POLLS = ${findPolls};
      let empties = 0; // consecutive polls showing a rendered but empty result list

      const attemptClick = () => {
        // 1. On a search results page, pick the best-matching hit - never blindly
        //    the first, which is how a search for one track used to come back
        //    with a different one that the store happened to rank higher.
        if (location.href.includes('/search')) {
          const errorEl = document.querySelector('.error h2, .error p');
          if (errorEl && /uh-oh|no results/i.test(errorEl.innerText || '')) {
            resolve({ outcome: 'no-results' });
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
            const title = titleEl ? titleEl.innerText.trim() : '';
            const artist = artistEl ? artistEl.innerText.trim() : '';
            const s = score(title, artist);
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

        // 2. Main album/track download button.
        const mainBtn = document.querySelector('.download-button');
        if (mainBtn) { mainBtn.click(); resolve({ outcome: 'clicked-download-button' }); return true; }

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
          if (text.includes('download track') || text === 'download' ||
              text.includes('download album') || text.includes('download full')) {
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
        else if (++polls > FIND_POLLS) { clearInterval(interval); resolve({ outcome: 'timeout' }); }
      }, 500);
    });
  `;
}
