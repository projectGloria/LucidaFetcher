import { useEffect, useMemo, useRef, useState } from 'react';
import { useItems, useStats, usePaused, useTransferProgress, getController } from '../engine.js';
import Icon from './Icon.jsx';

// Rows shown in the transfers pop-over before it says "+N more". The panel
// scrolls, but a list of forty identical progress bars answers nothing.
const MAX_ROWS = 8;
// Minimum gap between speed samples. Byte ticks arrive several times a second;
// a rate computed over 100ms jitters too much to read.
const SAMPLE_MS = 600;

function fmtBytes(n, digits) {
  if (!(n > 0)) return null;
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
  const d = digits === undefined ? (n < 10 && i > 1 ? 1 : 0) : digits;
  return `${n.toFixed(d)} ${u[i]}`;
}

/**
 * Per-transfer speed, smoothed.
 *
 * The old dock sampled bytes by mutating a ref *during render*, which is the
 * one thing a render must not do - StrictMode double-renders and concurrent
 * rendering can both run it twice per commit, double-counting the interval.
 * Sampling now happens in the progress listener, outside render, and only
 * commits state when a sample is actually taken (at most every SAMPLE_MS), so
 * it adds about two renders a second rather than one per byte tick.
 *
 * `active` is read through a ref so the subscription is made once, not torn
 * down and re-made on every structural change.
 */
function useTransferRates(active) {
  const [rates, setRates] = useState(() => new Map());
  const activeRef = useRef(active);
  const samples = useRef(new Map());

  useEffect(() => { activeRef.current = active; }, [active]);

  useEffect(() => {
    const store = getController();
    if (!store || typeof store.subscribeProgress !== 'function') return undefined;
    return store.subscribeProgress(() => {
      const now = Date.now();
      let changed = false;
      const live = new Set();
      for (const rec of activeRef.current) {
        const id = rec.item.id;
        live.add(id);
        if (rec.status !== 'downloading') continue;
        const got = rec.receivedBytes || 0;
        const prev = samples.current.get(id);
        if (!prev) { samples.current.set(id, { bytes: got, at: now, speed: null }); continue; }
        if (now - prev.at < SAMPLE_MS) continue;
        const inst = (Math.max(0, got - prev.bytes) * 1000) / (now - prev.at);
        // Exponential smoothing: steady enough to read, quick enough to notice
        // a stall within a couple of samples.
        const speed = prev.speed ? prev.speed * 0.6 + inst * 0.4 : inst;
        samples.current.set(id, { bytes: got, at: now, speed });
        changed = true;
      }
      for (const id of [...samples.current.keys()]) {
        if (!live.has(id)) { samples.current.delete(id); changed = true; }
      }
      if (changed) {
        setRates(new Map([...samples.current].map(([id, s]) => [id, s.speed])));
      }
    });
  }, []);

  return rates;
}

/**
 * The bar pinned along the bottom of the window.
 *
 * Replaces two things: the floating download dock, which sat on top of the
 * list it was describing and covered rows and Settings controls alike, and the
 * stat tiles and Pause/Cancel buttons wedged into the bottom of the sidebar.
 * Everything global now lives in one strip with a fixed place in the layout,
 * so nothing ever overlaps the content.
 */
export default function TransportBar({ onToast }) {
  // No byte subscription here. It used to sit on this component, re-rendering
  // the whole bar (buttons, stats, panel) on every progress tick - 250ms per
  // transfer, ~24 renders a second with six running. Only NowPlaying and
  // TransferRow draw bytes, so they subscribe themselves; speeds arrive via
  // useTransferRates, which already commits at most every SAMPLE_MS.
  const items = useItems();
  const stats = useStats();
  const paused = usePaused();
  const [open, setOpen] = useState(false);
  const panelRef = useRef(null);

  // Derived from the item list on structural changes only; byte ticks re-render
  // this component but reuse the memo, so a 10,000-track queue is not rescanned
  // several times a second.
  const { moving, waiting, active } = useMemo(() => {
    const unique = [...new Map(items.map((rec) => [rec.item.id, rec])).values()];
    const transferring = unique.filter((r) => r.status === 'downloading');
    const ready = unique.filter((r) => r.status === 'ready');
    return { moving: transferring, waiting: ready, active: [...transferring, ...ready] };
  }, [items]);

  const rates = useTransferRates(active);
  let totalRate = 0;
  for (const id of rates.keys()) totalRate += rates.get(id) || 0;

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target) && !e.target.closest?.('.transfers-toggle')) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  // Close the pop-over once there is nothing left in it. Merely hiding it (a
  // derived `open && active.length`) left `open` true, so the panel sprang back
  // open by itself the next time a transfer started. Setting state during render
  // is React's sanctioned way to adjust state from a changed input: it re-renders
  // immediately, before commit, with no effect and no flash of the stale panel.
  if (open && active.length === 0) setOpen(false);
  const panelOpen = open && active.length > 0;

  const c = getController();
  const pausedItems = stats.paused || 0;
  const idle = stats.queued + stats.active === 0;
  const retrying = !!(c && c.keepTrying && !c.retryStopped && stats.skipped > 0);
  const total = stats.total || 0;
  const share = (n) => (total ? `${(n / total) * 100}%` : '0%');

  const resumeAllPaused = () => {
    for (const item of c.getItems?.() || []) {
      if (item.status === 'paused') c.resumeItem?.(item.id);
    }
    if (paused) c.resume();
    onToast?.(`Resumed ${pausedItems} paused track${pausedItems === 1 ? '' : 's'}.`);
  };

  // One button, four meanings - the state decides which:
  //   globally paused             -> resume the engine
  //   idle with paused tracks     -> resume those tracks
  //   idle, nothing held back     -> nothing to do (disabled)
  //   running                     -> pause
  let primary;
  if (paused) primary = { icon: 'play', label: 'Resume downloads', run: () => c.resume() };
  else if (idle && pausedItems > 0) primary = { icon: 'play', label: `Resume ${pausedItems} paused`, run: resumeAllPaused };
  else if (idle && !retrying) primary = { icon: 'play', label: 'Nothing to download', run: null };
  else primary = { icon: 'pause', label: 'Pause downloads', run: () => c.pause() };

  const lead = moving[0] || waiting[0] || null;

  return (
    <footer className="transport" role="region" aria-label="Transfers">
      <div className="transport-now">
        {lead ? (
          <NowPlaying rec={lead} speed={rates.get(lead.item.id)} />
        ) : stats.active > 0 && !paused ? (
          // Searches in flight, nothing transferring yet. Deliberately blank:
          // the sidebar's "Now working" list shows which tracks and where, and
          // falling through to the lines below would claim "All finished" or
          // "N queued" while work is plainly running.
          null
        ) : (
          <span className="t-idle">
            {paused ? 'Paused'
              : retrying ? 'Waiting to retry missing tracks'
              : total === 0 ? 'Nothing queued'
              : stats.queued > 0 ? `${stats.queued} queued`
              : 'All finished'}
          </span>
        )}
      </div>

      <div className="transport-center">
        <div className="transport-buttons">
          <button
            type="button"
            className="icon-btn danger"
            onClick={() => c.cancelAll()}
            disabled={idle && !paused && !retrying}
            title="Cancel everything queued and in progress"
            aria-label="Cancel all"
          >
            <Icon name="x" size={16} />
          </button>
          <button
            type="button"
            className="play-btn"
            onClick={primary.run || undefined}
            disabled={!primary.run}
            title={primary.label}
            aria-label={primary.label}
          >
            <Icon name={primary.icon} size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => {
              const n = c.retrySkipped?.({ force: true }) || 0;
              onToast?.(n ? `Requeued ${n} missing track${n === 1 ? '' : 's'}.` : 'Nothing left to retry.');
            }}
            disabled={!stats.skipped}
            title={stats.skipped ? `Retry ${stats.skipped} missing` : 'Nothing missing'}
            aria-label="Retry missing tracks"
          >
            <Icon name="retry" size={16} />
          </button>
        </div>
        <div className="transport-overall" title={`${stats.completed} of ${total} downloaded`}>
          <span>{stats.completed}</span>
          <div className="seg-bar" role="progressbar" aria-label="Overall progress"
               aria-valuenow={total ? Math.round((stats.completed / total) * 100) : 0} aria-valuemin={0} aria-valuemax={100}>
            <span className="seg done" style={{ width: share(stats.completed) }} />
            <span className="seg working" style={{ width: share(stats.active) }} />
            <span className="seg missing" style={{ width: share(stats.skipped) }} />
          </div>
          <span>{total}</span>
        </div>
      </div>

      <div className="transport-stats">
        {totalRate > 0 && <span className="t-rate">{fmtBytes(totalRate, 1)}/s</span>}
        <span className="t-stat hide-narrow"><b>{stats.active}</b>active</span>
        <span className="t-stat ok hide-narrow"><b>{stats.completed}</b>done</span>
        <span className={`t-stat${stats.skipped ? ' warn' : ''}`}><b>{stats.skipped}</b>missing</span>
        <button
          type="button"
          className="btn btn-sm btn-ghost transfers-toggle"
          aria-expanded={panelOpen}
          disabled={!active.length}
          onClick={() => setOpen((o) => !o)}
          title="Show live transfers"
        >
          <Icon name="list" size={15} />
          {active.length}
        </button>
      </div>

      {panelOpen && (
        <div className="transfers-panel" ref={panelRef} role="dialog" aria-label="Live transfers">
          <header>
            Transferring {moving.length}{waiting.length > 0 && ` · ${waiting.length} ready`}
            <span style={{ flex: 1 }} />
            <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
              <Icon name="chevronDown" size={16} />
            </button>
          </header>
          {active.slice(0, MAX_ROWS).map((rec) => (
            <TransferRow key={rec.item.id} rec={rec} speed={rates.get(rec.item.id)} />
          ))}
          {active.length > MAX_ROWS && <div className="transfers-more">+{active.length - MAX_ROWS} more in flight</div>}
        </div>
      )}
    </footer>
  );
}

function pctOf(rec) {
  return typeof rec.progress === 'number' ? Math.round(rec.progress * 100) : null;
}

function Art({ rec, className }) {
  return rec.item.image
    ? <img className={className} src={rec.item.image} alt="" referrerPolicy="no-referrer" />
    : <div className={className} aria-hidden="true"><Icon name="music" size={16} /></div>;
}

function NowPlaying({ rec, speed }) {
  useTransferProgress(); // byte ticks: rec is the live record (or reads it through getters), so a re-render picks up new bytes
  const isReady = rec.status === 'ready';
  const pct = pctOf(rec);
  return (
    <>
      <Art rec={rec} className="t-art" />
      <div className="t-copy">
        <div className="t-title truncate">{rec.item.title || rec.item.name}</div>
        <div className="t-sub truncate">
          <span className="transfer-pct">{isReady ? 'Ready' : pct === null ? '—' : `${pct}%`}</span>
          {rec.item.artist ? ` · ${rec.item.artist}` : ''}
          {speed > 0 ? ` · ${fmtBytes(speed, 1)}/s` : ''}
        </div>
      </div>
    </>
  );
}

function TransferRow({ rec, speed }) {
  useTransferProgress(); // byte ticks: rec is the live record (or reads it through getters), so a re-render picks up new bytes
  const isReady = rec.status === 'ready';
  const pct = pctOf(rec);
  const size = fmtBytes(rec.totalBytes);
  const got = fmtBytes(rec.receivedBytes);
  const targetId = rec.id || rec.item.id;
  return (
    <div className="transfer-row">
      <Art rec={rec} className="t-art" />
      <div className="transfer-body">
        <div className="transfer-line">
          <span className="transfer-title truncate">{rec.item.title || rec.item.name}</span>
          <span className="transfer-pct">{isReady ? 'Ready' : pct === null ? '—' : `${pct}%`}</span>
        </div>
        <div className={`progress ${isReady ? 'waiting' : pct === null ? 'indeterminate' : ''}`}>
          <i style={{ width: isReady ? 0 : pct === null ? undefined : `${pct}%` }} />
        </div>
        <div className="transfer-line transfer-meta">
          <span className="truncate">{rec.item.artist || ''}</span>
          {size && <span>{got || '0 B'} / {size}</span>}
          {speed > 0 && <span>{fmtBytes(speed, 1)}/s</span>}
        </div>
      </div>
      <button type="button" className="icon-btn" onClick={() => getController()?.pauseItem?.(targetId)} title="Pause this transfer" aria-label="Pause this transfer">
        <Icon name="pause" size={13} />
      </button>
      <button type="button" className="icon-btn danger" onClick={() => getController()?.cancel?.(targetId)} title="Cancel this transfer" aria-label="Cancel this transfer">
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
