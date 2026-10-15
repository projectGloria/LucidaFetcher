import { useEffect, useState } from 'react';
import { getController, isElectron, ipc } from '../engine.js';
import { serviceLabel } from '../../engine/status.mjs';
import { displayedService } from '../../engine/source-display.mjs';
import SourceIcon from './SourceIcon.jsx';
// Past this, a search reads as slow rather than routine - long enough that
// most real answers have already come back, short enough to say something
// before the user starts wondering if the app is frozen.
const SLOW_AFTER_MS = 45000;

// Which visual weight a status carries. "searching" is deliberately quiet: in a
// list of two hundred rows, most of them are searching most of the time, and
// making that state loud turns the whole list into noise.
const TONE = {
  queued:      { pill: '',        label: 'Queued' },
  searching:   { pill: 'accent live', label: 'Working' },
  // Fetched and handed to the network, nothing moving yet. Given its own tone
  // rather than folded into "Downloading": the whole point is being able to see
  // at a glance how much work is already banked ahead of the transfers.
  ready:       { pill: 'info',        label: 'Ready' },
  downloading: { pill: 'info live',   label: 'Downloading' },
  completed:   { pill: 'ok',      label: 'Done' },
  skipped:     { pill: 'warn',    label: 'Missing' },
  cancelled:   { pill: '',        label: 'Cancelled' },
};

export default function TrackRow({ rec }) {
  const { item, status, statusText } = rec;
  const tone = TONE[status] || TONE.queued;
  const busy = status === 'searching' || status === 'ready' || status === 'downloading';
  const pct = typeof rec.progress === 'number' ? Math.round(rec.progress * 100) : null;
  const elapsed = useElapsed(status === 'searching' ? rec.attemptStartedAt : null);
  const slow = elapsed !== null && elapsed >= SLOW_AFTER_MS;
  useRowProgress(rec);

  const statusClass =
    status === 'skipped' ? 'status warnc'
    : status === 'cancelled' ? 'status err'
    : 'status';

  const openFolder = () => {
    if (!isElectron) return;
    ipc.invoke('open-item-folder', {
      savePath: rec.result && rec.result.savePath,
      folderName: item.folderName,
    }).catch(() => {});
  };

  return (
    <div className={`row ${status === 'completed' ? 'done' : ''} ${status === 'skipped' ? 'skipped' : ''}`}>
      {item.image
        ? <img className="art" src={item.image} alt="" loading="lazy" referrerPolicy="no-referrer" />
        : <div className="art" aria-hidden="true" />}

      <div className="info">
        <div className="title">{item.title || item.name}</div>
        <div className="artist">{item.artist}</div>
        {/* The whole point of the redesign: not "Fetching…" but which source is
            being asked, and what the last one actually said. */}
        <div className={statusClass}>
          <SourceTrail rec={rec} />
          <span className="truncate" title={statusText}>{statusText}</span>
          {/* Below SLOW_AFTER_MS this is silent - most searches are quick and a
              timer on every row would just be noise. Past it, it is the one
              thing that tells "still working" apart from "looks frozen". */}
          {slow && <span className="elapsed" title="How long the current source has been asked">{formatElapsed(elapsed)}</span>}
        </div>
      </div>

      <span
        className={`pill ${tone.pill} ${slow ? 'slow' : ''}`}
        title={rec.reused && status === 'completed' ? 'Already downloaded for another playlist' : undefined}
      >
        {busy && <span className="dot" />}
        {status === 'downloading' && pct !== null
          ? `${pct}%`
          : rec.reused && status === 'completed'
            ? 'Done (reused)'
            : tone.label}
      </span>

      <div className="actions">
        {status === 'completed' && isElectron && (
          <button className="btn btn-sm btn-ghost btn-icon" onClick={openFolder} title="Show in folder">⌕</button>
        )}
        {(status === 'queued' || busy) && (
          <button
            className="btn btn-sm btn-ghost btn-icon btn-danger"
            onClick={() => getController().cancel(rec.id || item.id)}
            title="Cancel this track"
          >✕</button>
        )}
        {!busy && status !== 'queued' && (
          <button
            className="btn btn-sm btn-ghost btn-icon btn-danger"
            onClick={() => getController().remove(rec.id || item.id)}
            title="Remove from the list (the file, if any, stays)"
          >🗑</button>
        )}
      </div>

      {(status === 'downloading' || status === 'ready') && (
        <div className="bar">
          {/* A ready track gets a flat empty bar, not the indeterminate sweep:
              the sweep means "moving, length unknown", and this one is not
              moving at all yet. */}
          <div className={`progress ${status === 'ready' ? 'waiting' : pct === null ? 'indeterminate' : ''}`}>
            <i style={{ width: status === 'ready' ? 0 : pct === null ? undefined : `${pct}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Milliseconds since `startedAt`, ticking once a second while it is set. */
function useElapsed(startedAt) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return startedAt ? now - startedAt : null;
}

/**
 * Re-render this row - and only this row - when its own bytes move.
 *
 * Progress ticks used to bump the whole store's version, which re-rendered
 * every group, every row and the sidebar several times a second for the sake
 * of the one or two rows actually transferring. The records are mutated in
 * place, so a memo on `rec` would freeze the row entirely; subscribing here
 * and comparing against the last seen value keeps idle rows asleep while a
 * downloading row stays live. Status changes still arrive through the parent,
 * which re-renders on the status version as before.
 */
function useRowProgress(rec) {
  const [, force] = useState(0);
  useEffect(() => {
    const store = getController();
    if (!['ready', 'downloading'].includes(rec.status) || !store || typeof store.subscribeProgress !== 'function') return undefined;
    let lastProgress = rec.progress;
    let lastBytes = rec.receivedBytes;
    return store.subscribeProgress(() => {
      if (rec.progress !== lastProgress || rec.receivedBytes !== lastBytes) {
        lastProgress = rec.progress;
        lastBytes = rec.receivedBytes;
        force((n) => n + 1);
      }
    });
  }, [rec, rec.status]);
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function SourceTrail({ rec }) {
  const service = displayedService(rec);
  if (!service) return null;
  const label = rec.status === 'completed' ? 'Downloaded from'
    : rec.status === 'downloading' ? 'Downloading from'
    : rec.status === 'ready' ? 'Fetched from'
    : 'Searching';
  return (
    <span className="trail">
      <span className={rec.status === 'completed' ? 'hop ok' : 'hop now'} title={label + ' ' + serviceLabel(service)}>
        <SourceIcon service={service} size={24} />
      </span>
    </span>
  );
}
