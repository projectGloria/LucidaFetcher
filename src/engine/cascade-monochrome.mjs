// The Monochrome search-page cascade.
//
// Monochrome does not link to a file. It resolves a stream, fetches it, may
// remux it in ffmpeg.wasm, and only then hands the browser a blob through an
// <a download>. So "did this work?" cannot be answered by watching for a
// navigation. Two signals settle it: that anchor click, hooked because it is
// the exact moment Chromium's will-download fires, and the site's own error
// toast, which is the only thing it says when a track has no stream.
//
// WHY THIS IS A LOOP. The previous version scored every card, took the single
// best one, clicked Download, and reported whatever happened to it. When the
// toast said "no audio stream is available for this track" the whole track was
// written off - even though the site regularly lists the same recording several
// times and only some of those entries resolve a stream. Across the user's logs
// that single-shot behaviour produced 29 provider-failures against 24
// successes. Walking the ranked candidates instead turns most of those 29 into
// a second or third attempt that costs one menu click, because the search page
// is already loaded: no re-navigation, no re-render, no new page budget.

import { injectableScorer, MIN_TITLE_SCORE } from './matching.mjs';

export const MONOCHROME_FIND_POLLS = 60;        // 500ms each - waiting for the SPA to render cards
export const MONOCHROME_CANDIDATE_POLLS = 30;   // 1s each - stream resolve + remux, PER candidate
export const MONOCHROME_TOTAL_POLLS = 90;       // 1s each - overall ceiling across all candidates
export const MONOCHROME_MAX_CANDIDATES = 4;     // how far down the ranking to walk

export function buildMonochromeScript(expected, opts = {}) {
  const findPolls = opts.findPolls ?? MONOCHROME_FIND_POLLS;
  const candidatePolls = opts.candidatePolls ?? MONOCHROME_CANDIDATE_POLLS;
  const totalPolls = opts.totalPolls ?? MONOCHROME_TOTAL_POLLS;
  const maxCandidates = opts.maxCandidates ?? MONOCHROME_MAX_CANDIDATES;

  return `
    new Promise((resolve) => {
${injectableScorer(expected, opts.minTitleScore ?? MIN_TITLE_SCORE)}

      const FIND_POLLS = ${findPolls};
      const CANDIDATE_POLLS = ${candidatePolls};
      const TOTAL_POLLS = ${totalPolls};
      const MAX_CANDIDATES = ${maxCandidates};

      let done = false, spent = 0, CONSIDERED = 0;
      let RANKED = [], ATTEMPTS = [], LABEL = null;
      const undo = [];
      const finish = (value) => {
        if (done) return;
        done = true;
        undo.forEach((fn) => { try { fn(); } catch (e) { /* nothing to unwind */ } });
        resolve(Object.assign({
          attempts: ATTEMPTS,
          considered: CONSIDERED,
          candidates: RANKED.slice(0, 5).map((c) => ({
            title: c.title, artist: c.artist,
            t: Math.round(c.s.t * 100) / 100,
            p: Math.round(c.s.p * 100) / 100,
            a: c.s.a
          }))
        }, value));
      };

      // A download attempt ends in an <a download> click. Hooking the prototype
      // catches it whatever element the page builds, and forwarding to the real
      // click first means the download still happens - this only observes it.
      const nativeClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        const isFile = !!this.download;
        const out = nativeClick.call(this);
        if (isFile) finish({ outcome: 'download-triggered', label: LABEL, file: this.download });
        return out;
      };
      undo.push(() => { HTMLAnchorElement.prototype.click = nativeClick; });

      const ERR = /too many requests|rate[ -]?limit|couldn.?t download|could not find audio source|failed to download|no audio stream|not found on the provider|cannot be downloaded|failed to play/i;
      const readError = (text) => {
        if (!ERR.test(text || '')) return null;
        const lines = String(text).split('\\n').map((l) => l.trim()).filter((l) => ERR.test(l));
        return lines[0] || String(text).trim().slice(0, 200);
      };

      // These toasts dismiss themselves, and a 1s poll misses one that came and
      // went in between - which reads as a hang rather than the failure it was.
      // So latch the first error the container ever shows. The container is
      // created lazily, on the page's first notice, so watching for it has to
      // start at the body and narrow down once it exists.
      // The text the notice container held when the current attempt began. The
      // observer latch below only fires on NEW mutations, but the polled
      // backstop reads whatever is on screen - and Monochrome's toasts linger
      // for seconds, so without this baseline the next candidate would read the
      // previous one's toast 250ms later and fail instantly, collapsing the
      // whole walk back into the single-shot behaviour it replaces.
      let baselineText = '';
      let latchedError = null, watched = null;
      const watchNotices = () => {
        const host = document.getElementById('download-notifications');
        if (!host || host === watched) return;
        watched = host;
        if (!latchedError) latchedError = readError(host.innerText || '');
        const observer = new MutationObserver(() => {
          if (!latchedError) latchedError = readError(host.innerText || '');
        });
        observer.observe(host, { childList: true, subtree: true, characterData: true });
        undo.push(() => observer.disconnect());
      };
      watchNotices();
      if (document.body && typeof MutationObserver === 'function') {
        const bodyObserver = new MutationObserver(() => {
          if (!watched && document.getElementById('download-notifications')) {
            watchNotices();
          }
        });
        bodyObserver.observe(document.body, { childList: true, subtree: true });
        undo.push(() => bodyObserver.disconnect());
      }
      const errorNotice = () => {
        watchNotices();
        if (latchedError) return latchedError;
        const host = document.getElementById('download-notifications');
        const text = host ? (host.innerText || '') : '';
        // Only the backstop needs the baseline guard: unchanged text is a toast
        // left over from a previous candidate, not a verdict on this one.
        return text && text !== baselineText ? readError(text) : null;
      };

      const clean = (el) => (el ? el.innerText || '' : '').replace(/\\s+/g, ' ').trim();
      // The artist cell reads "Obzkure - 2023" with a bullet - the year is on the
      // same line and would otherwise score as an unmatched artist token.
      const cleanArtist = (el) => clean(el).replace(/\\s*[\\u2022\\u00b7]\\s*\\d{4}\\s*$/, '').trim();

      // The row menu stays open after a failed attempt and would swallow the
      // next row's click, so it has to be dismissed between candidates.
      const dismissMenu = () => {
        const menu = document.getElementById('context-menu');
        if (menu && getComputedStyle(menu).display !== 'none') {
          document.body.click();
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        }
      };

      // Click Download on one card and wait to learn what happened to it.
      // onFail receives the toast text (or null on timeout) so the caller can
      // move to the next candidate. Success is not reported here - it arrives
      // through the anchor hook above.
      const attempt = (cand, onFail) => {
        // CRITICAL: clear the latch first. The previous candidate's toast is
        // still sitting in it, and inheriting that would fail this candidate
        // instantly without ever waiting for its own result.
        latchedError = null;
        const noticeHost = document.getElementById('download-notifications');
        baselineText = noticeHost ? (noticeHost.innerText || '') : '';
        LABEL = cand.title + ' - ' + cand.artist;

        const trigger = cand.el.querySelector('.track-menu-btn');
        if (!trigger) { onFail('no download control'); return; }
        trigger.click();

        let opening = 0;
        const openTimer = setInterval(() => {
          const menu = document.getElementById('context-menu');
          const entry = menu && menu.querySelector('li[data-action="download"]');
          const open = menu && getComputedStyle(menu).display !== 'none';
          if (entry && open) {
            clearInterval(openTimer);
            entry.click();
            let polls = 0;
            const waitTimer = setInterval(() => {
              spent++;
              const err = errorNotice();
              if (err) {
                clearInterval(waitTimer);
                if (/too many requests|rate[ -]?limit/i.test(err)) finish({ outcome: 'rate-limited', message: err });
                else onFail(err);
              }
              else if (spent > TOTAL_POLLS) { clearInterval(waitTimer); finish({ outcome: 'timeout', label: LABEL }); }
              else if (++polls > CANDIDATE_POLLS) { clearInterval(waitTimer); onFail(null); }
            }, 1000);
            undo.push(() => clearInterval(waitTimer));
          } else if (++opening > 20) {
            clearInterval(openTimer);
            onFail('no download control');
          }
        }, 200);
        undo.push(() => clearInterval(openTimer));
      };

      // Walk the ranking. Success resolves through the anchor hook, so this
      // only ever advances on failure.
      const walk = (usable, i) => {
        if (done) return;
        if (i >= usable.length) {
          const firstError = (ATTEMPTS.find((a) => a.error) || {}).error || null;
          finish({ outcome: 'provider-failed', label: LABEL, message: firstError, exhausted: usable.length });
          return;
        }
        attempt(usable[i], (err) => {
          ATTEMPTS.push({ title: usable[i].title, artist: usable[i].artist, error: err });
          dismissMenu();
          setTimeout(() => walk(usable, i + 1), 250);
        });
      };

      const findAndStart = () => {
        const host = document.getElementById('search-tracks-container');
        if (!host) return false; // the SPA has not rendered the tracks tab yet
        const placeholder = host.querySelector('.placeholder-text');
        if (placeholder && /no tracks found/i.test(placeholder.innerText || '')) {
          finish({ outcome: 'no-results' });
          return true;
        }
        const cards = Array.from(host.querySelectorAll('.track-item'));
        if (!cards.length) return false; // still loading

        const scored = [];
        for (const card of cards) {
          const title = clean(card.querySelector('.track-item-details .title'));
          if (!title) continue;
          const artist = cleanArtist(card.querySelector('.track-item-details .artist'));
          const s = score(title, artist, durationOf(card.querySelector('.duration, .track-duration, .track-item-duration, [data-duration]')));
          scored.push({ el: card, title, artist, s, acceptable: isAcceptable(s, MIN_TITLE_SCORE) });
        }
        scored.sort((x, y) => (y.s.a - x.s.a) || (y.s.t - x.s.t) || (y.s.p - x.s.p));
        RANKED = scored;
        CONSIDERED = scored.length;
        LABEL = scored.length ? scored[0].title + ' - ' + scored[0].artist : 'none';

        // Walking the ranking is only safe among entries that are the SAME
        // recording listed more than once - which is what a site with several
        // stream backends looks like. Merely "acceptable" is not enough: the
        // gate scores recall, so for expected "Fetish" the different song
        // "Money Fetish" also passes (every expected token is present, artist
        // matches). Falling through to that would download the wrong track,
        // which is worse than the skip this loop exists to prevent. Requiring
        // an identical title token-set keeps real alternates - STOP folds
        // "(Original Mix)" and "(album version)" onto the bare title - while
        // refusing anything that is a different song.
        const keyOf = (s) => toks(s, FOLD, STOP, norm).slice().sort().join(' ');
        const best = scored.find((c) => c.acceptable);
        if (!best) {
          finish({ outcome: 'no-match', label: LABEL });
          return true;
        }
        const bestKey = keyOf(best.title);
        const usable = scored
          .filter((c) => c.acceptable && keyOf(c.title) === bestKey)
          .slice(0, MAX_CANDIDATES);
        walk(usable, 0);
        return true;
      };

      if (findAndStart()) return;
      let polls = 0;
      const timer = setInterval(() => {
        if (done || findAndStart()) { clearInterval(timer); return; }
        if (++polls > FIND_POLLS) { clearInterval(timer); finish({ outcome: 'no-results' }); }
      }, 500);
      undo.push(() => clearInterval(timer));
    });
  `;
}
