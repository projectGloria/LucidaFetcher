import { useMemo, useRef, useState } from 'react';
import { useItems, useTransferProgress, getController } from '../engine.js';

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
  useTransferProgress();
  const items = useItems();
  const [minimized, setMinimized] = useState(false);

  const { moving, waiting, active } = useMemo(() => {
    const unique = [...new Map(items.map(rec => [rec.item.id, rec])).values()];
    const transferring = unique.filter(r => r.status === 'downloading');
    const ready = unique.filter(r => r.status === 'ready');
    return { moving: transferring, waiting: ready, active: [...transferring, ...ready] };
  }, [items]);

  const samples = useRef(new Map());

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
    } else if (now - prev.at >= 600) {
      const inst = (Math.max(0, got - prev.bytes) * 1000) / (now - prev.at);
      speed = prev.speed ? prev.speed * 0.6 + inst * 0.4 : inst;
      samples.current.set(rec.item.id, { bytes: got, at: now, speed });
    }
    if (speed) totalRate += speed;
    return { rec, speed };
  });

  const shown = rows.slice(0, MAX_ROWS);

  return (
    <div className={`dock ${minimized ? 'dock-minimized' : ''}`} role="status" aria-live="off">
      <div className="dock-head">
        <span className="dock-pulse" aria-hidden="true" />
        <span className="dock-head-label">
          Downloading {moving.length === 1 ? '1 track' : `${moving.length} tracks`}
          {waiting.length > 0 && ` · ${waiting.length} ready`}
        </span>
        {totalRate > 0 && <span className="dock-head-rate">{fmtBytes(totalRate, 1)}/s</span>}
        <button
          type="button"
          className="btn btn-sm btn-ghost btn-icon dock-toggle"
          onClick={() => setMinimized((m) => !m)}
          title={minimized ? 'Expand transfer deck' : 'Minimize transfer deck'}
          aria-label={minimized ? 'Expand transfer deck' : 'Minimize transfer deck'}
        >
          {minimized ? '▴' : '▾'}
        </button>
      </div>

      <div className="dock-rows" style={minimized ? { display: 'none' } : undefined}>
        {shown.map(({ rec, speed }) => {
          const isReady = rec.status === 'ready';
          const pct = typeof rec.progress === 'number' ? Math.round(rec.progress * 100) : null;
          const size = fmtBytes(rec.totalBytes);
          const got = fmtBytes(rec.receivedBytes);
          const targetId = rec.id || rec.item.id;
          return (
            <div className="dock-row" key={rec.item.id}>
              {rec.item.image
                ? <img className="dock-art" src={rec.item.image} alt="" />
                : <div className="dock-art" aria-hidden="true" />}
              <div className="dock-body">
                <div className="dock-line">
                  <span className="dock-title truncate">{rec.item.title || rec.item.name}</span>
                  <span className="dock-row-controls">
                    <span className="dock-pct">{isReady ? 'Ready' : pct === null ? '—' : `${pct}%`}</span>
                    <button
                      type="button"
                      className="dock-action-btn"
                      onClick={() => getController()?.pauseItem?.(targetId)}
                      title="Pause this transfer"
                    >❚❚</button>
                    <button
                      type="button"
                      className="dock-action-btn danger"
                      onClick={() => getController()?.cancel?.(targetId)}
                      title="Cancel this transfer"
                    >✕</button>
                  </span>
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

      {!minimized && active.length > MAX_ROWS && (
        <div className="dock-foot">+{active.length - MAX_ROWS} more in flight</div>
      )}
    </div>
  );
}
