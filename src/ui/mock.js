// A stand-in controller for working on the interface outside Electron.
//
// It implements the same surface the real Controller exposes to the UI, and
// walks tracks through the same statuses and the same status wording, so the
// preview exercises the real states rather than a prettier fiction. It is never
// loaded when window.require exists.

import { describeStep, describeOutcome, describeAbandon, serviceLabel } from '../engine/status.mjs';
import { buildPlan } from '../engine/chain.mjs';
import { buildSearchVariants } from '../engine/variants.mjs';

const SAMPLE = [
  ['Carnage', 'WIB3X', 'KAN'],
  ['Stardust', 'Call Me Sleeper', 'KAN'],
  ['PARADISE', 'MVDNES', 'KAN'],
  ['Snake', 'MVDNES', 'KAN'],
  ['Hidden Desire', 'Obzkure', 'KAN'],
  ['RAVE', 'Dxrk ダーク', 'KAN'],
  ['Adrenaline', 'Sophie-Tith', 'KAN'],
  ['DAVID', 'WYR GEMI', 'KAN'],
  ['Fetish', 'Obzkure', 'KAN'],
  ['Dark Essence', 'Dirrek, Tsunca', 'KAN'],
  ['Imperial Ghost', 'Blazzefall', 'KAN'],
  ['Vegeta', 'ZVEN', 'KAN'],
  ['Numb', 'Sinny & 7vvch', 'KAN'],
  ['Asphyxia', 'Tenebrax', 'KAN'],
  ['Montana', 'BeeBars', 'KAN'],
];

export function makeMockController() {
  let version = 0;
  const listeners = new Set();
  const emit = () => { version++; listeners.forEach((f) => f()); };

  const items = new Map();
  SAMPLE.forEach(([title, artist, folder], i) => {
    const id = `mock-${i}`;
    const item = {
      id, title, artist, name: `${artist} - ${title}`,
      folderName: folder, groupId: 'g-kan', groupName: 'KAN',
      originalService: 'qobuz',
      searchVariants: buildSearchVariants(title, artist),
    };
    items.set(id, {
      item, status: 'queued', statusText: 'Waiting in queue',
      tried: [], plan: buildPlan({ variants: item.searchVariants, services: ['qobuz', 'amazon'] }),
      step: null, result: null,
    });
  });

  const ctrl = {
    subscribe(f) { listeners.add(f); return () => listeners.delete(f); },
    getSnapshot: () => version,
    subscribeProgress(f) { listeners.add(f); return () => listeners.delete(f); },
    getProgressSnapshot: () => version,
    getItems: () => [...items.values()],
    getItem: (id) => items.get(id),
    paused: false,
    keepTrying: false,
    setKeepTrying(enabled) { ctrl.keepTrying = !!enabled; emit(); },
    pool: { concurrency: 3 },
    get stats() {
      let queued = 0, active = 0, completed = 0, skipped = 0;
      for (const r of items.values()) {
        if (r.status === 'completed') completed++;
        else if (r.status === 'skipped') skipped++;
        else if (r.status === 'searching' || r.status === 'ready' || r.status === 'downloading') active++;
        else if (r.status === 'queued') queued++;
      }
      return { queued, active, completed, skipped, total: items.size };
    },
    pause() { ctrl.paused = true; emit(); },
    resume() { ctrl.paused = false; emit(); },
    setConcurrency(n) { ctrl.pool.concurrency = n; emit(); },
    cancel(id) { const r = items.get(id); if (r) { r.status = 'cancelled'; r.statusText = 'Cancelled'; emit(); } },
    cancelAll() { for (const r of items.values()) if (r.status !== 'completed') { r.status = 'cancelled'; r.statusText = 'Cancelled'; } emit(); },
    remove(ids) {
      let n = 0;
      for (const id of Array.isArray(ids) ? ids : [ids]) { if (items.delete(id)) n++; }
      emit(); return n;
    },
    removeGroup(id) { return ctrl.remove([...items.values()].filter(r => (r.item.groupId || '__loose__') === id).map(r => r.item.id)); },
    retrySkipped() {
      let n = 0;
      for (const r of items.values()) if (r.status === 'skipped') { r.status = 'queued'; r.statusText = 'Queued for one more try'; r.tried = []; n++; }
      emit(); return n;
    },
    add(next = []) {
      let added = 0;
      for (const item of next) {
        if (!item?.id || items.has(item.id)) continue;
        items.set(item.id, {
          item,
          status: 'queued',
          statusText: 'Waiting in queue',
          tried: [],
          plan: buildPlan({
            variants: item.searchVariants,
            services: ['qobuz', 'amazon'],
            directUrl: item.mediaUrl,
            directService: item.mediaService,
          }),
          step: null,
          result: null,
        });
        added++;
      }
      if (added) emit();
      return added;
    },
  };

  // Walk three tracks at a time through the real status vocabulary.
  const running = new Set();
  setInterval(() => {
    if (ctrl.paused) return;
    for (const r of items.values()) {
      if (running.size >= 3) break;
      if (r.status === 'queued' && !running.has(r.item.id)) { running.add(r.item.id); advance(r); }
    }
  }, 900);

  function advance(rec) {
    let i = 0;
    const stopped = () => !items.has(rec.item.id) || rec.status === "cancelled";
    const tick = () => {
      if (stopped()) { running.delete(rec.item.id); return; }
      if (ctrl.paused) { setTimeout(tick, 500); return; }
      const step = rec.plan[i];
      if (!step) {
        rec.status = 'skipped';
        rec.statusText = describeAbandon(rec.tried);
        running.delete(rec.item.id); emit(); return;
      }
      rec.step = step;
      rec.status = 'searching';
      rec.statusText = describeStep(step, rec.plan);
      emit();

      setTimeout(() => {
        if (stopped()) { running.delete(rec.item.id); return; }
        // Deterministic per track so the preview is stable between reloads.
        const seed = (rec.item.id.charCodeAt(5) + i * 7) % 10;
        if (seed > 6 || (i >= 2 && seed > 3)) {
          rec.status = 'downloading';
          rec.progress = 0;
          emit();
          const grow = setInterval(() => {
            if (stopped()) { clearInterval(grow); running.delete(rec.item.id); return; }
            rec.progress = Math.min(1, (rec.progress || 0) + 0.12);
            rec.statusText = `Downloading from ${serviceLabel(step.service)}`;
            emit();
            if (rec.progress >= 1) {
              clearInterval(grow);
              rec.status = 'completed';
              rec.statusText = 'Downloaded';
              rec.tried.push({ service: step.service, outcome: 'completed' });
              running.delete(rec.item.id); emit();
            }
          }, 320);
          return;
        }
        const outcome = seed > 4 ? 'no-match' : seed > 2 ? 'no-results' : 'provider-failed';
        rec.tried.push({ service: step.service, outcome, label: outcome === 'no-match' ? 'A Different Song - Someone Else' : null });
        rec.statusText = describeOutcome(outcome, { service: step.service, label: outcome === 'no-match' ? 'A Different Song - Someone Else' : null });
        emit();
        i++;
        setTimeout(tick, 700);
      }, 900);
    };
    tick();
  }

  return ctrl;
}
