import { useRef } from 'react';
import { useItems } from '../engine.js';

// One panel at the bottom of the window for whatever is transferring right now.
//
// Deliberately a single panel rather than a stack of cards: three floating
// cards read as three notifications competing for attention, when they are
// really one fact - "this is what the app is doing" - with three lines in it.

const MAX_ROWS = 3;

function fmtBytes(n, digits) {
  if (!(n > 0)) return null;
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
  const d = digits === undefined ? (n < 10 && i > 1 ? 1 : 0) : digits;
  return `${n.toFixed(d)} ${u[i]}`;
}

export default function DownloadDock() {
  const items = useItems();
  // Byte counters are cumulative, so a rate has to be derived from two
  // readings. They live in a ref because they are display detail: as state they
  // would re-render the dock on their own account as well as on every progress
  // event, which arrive several times a second per track.
  const samples = useRef(new Map());

  // Moving files first, then the ones already fetched and waiting their turn.
  // Both belong in here: the panel answers "what is the app doing", and a track
  // that has been scraped and handed to the network is as much a live piece of
  // work as one whose bytes happen to be arriving this second.
  const moving = items.filter((r) => r.status === 'downloading');
  const waiting = items.filter((r) => r.status === 'ready');
  const active = [...moving, ...waiting];
  if (!active.length) {
    if (samples.current.size) samples.current.clear();
    return null;
  }

  const now = Date.now();
  for (const id of [...samples.current.keys()]) {
    if (!active.some((r) => r.item.id === id)) samples.current.delete(id);
  }

  let totalRate = 0;
  const rows = active.map((rec) => {
    if (rec.status === 'ready') return { rec, speed: null };
    const got = rec.receivedBytes || 0;
    const prev = samples.current.get(rec.item.id);
    let speed = prev ? prev.speed : null;
    if (!prev) {
      samples.current.set(rec.item.id, { bytes: got, at: now, speed: null });
    } else if (now - prev.at >= 600 && got > prev.bytes) {
      // Smoothed, because a raw delta between two samples jumps around far too
      // much to read as a number.
      const inst = ((got - prev.bytes) * 1000) / (now - prev.at);
      speed = prev.speed ? prev.speed * 0.6 + inst * 0.4 : inst;
      samples.current.set(rec.item.id, { bytes: got, at: now, speed });
    }
    if (speed) totalRate += speed;
    return { rec, speed };
  });

  const shown = rows.slice(0, MAX_ROWS);

  return (
    <div className="dock" role="status" aria-live="off">
      <div className="dock-head">
        <span className="dock-pulse" aria-hidden="true" />
        <span className="dock-head-label">
          Downloading {moving.length === 1 ? '1 track' : `${moving.length} tracks`}
          {waiting.length > 0 && ` · ${waiting.length} ready`}
        </span>
        {totalRate > 0 && <span className="dock-head-rate">{fmtBytes(totalRate, 1)}/s</span>}
      </div>

      <div className="dock-rows">
        {shown.map(({ rec, speed }) => {
          const isReady = rec.status === 'ready';
          const pct = typeof rec.progress === 'number' ? Math.round(rec.progress * 100) : null;
          const size = fmtBytes(rec.totalBytes);
          const got = fmtBytes(rec.receivedBytes);
          return (
            <div className="dock-row" key={rec.item.id}>
              {rec.item.image
                ? <img className="dock-art" src={rec.item.image} alt="" />
                : <div className="dock-art" aria-hidden="true" />}
              <div className="dock-body">
                <div className="dock-line">
                  <span className="dock-title truncate">{rec.item.title || rec.item.name}</span>
                  <span className="dock-pct">{isReady ? 'Ready' : pct === null ? '—' : `${pct}%`}</span>
                </div>
                <div className={`progress dock-bar ${isReady ? 'waiting' : pct === null ? 'indeterminate' : ''}`}>
                  <i style={{ width: isReady ? 0 : pct === null ? undefined : `${pct}%` }} />
                </div>
                <div className="dock-line dock-meta">
                  <span className="truncate">{rec.item.artist || ''}</span>
                  <span className="dock-numbers">
                    {size && <span>{got} / {size}</span>}
                    {speed > 0 && <span className="dock-rate">{fmtBytes(speed, 1)}/s</span>}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {active.length > MAX_ROWS && (
        <div className="dock-foot">+{active.length - MAX_ROWS} more in flight</div>
      )}
    </div>
  );
}
