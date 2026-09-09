import { getController, isElectron, ipc } from '../engine.js';
import { serviceLabel } from '../../engine/status.mjs';
import { displayedService } from '../../engine/source-display.mjs';
import SourceIcon from './SourceIcon.jsx';

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

  const statusClass =
    status === 'skipped' ? 'status warnc'
    : status === 'cancelled' ? 'status err'
    : 'status';

  const openFolder = () => {
    if (!isElectron) return;
    ipc.send('open-item-folder', {
      savePath: rec.result && rec.result.savePath,
      folderName: item.folderName,
    });
  };

  return (
    <div className={`row ${status === 'completed' ? 'done' : ''} ${status === 'skipped' ? 'skipped' : ''}`}>
      {item.image
        ? <img className="art" src={item.image} alt="" loading="lazy" />
        : <div className="art" aria-hidden="true" />}

      <div className="info">
        <div className="title">{item.title || item.name}</div>
        <div className="artist">{item.artist}</div>
        {/* The whole point of the redesign: not "Fetching…" but which source is
            being asked, and what the last one actually said. */}
        <div className={statusClass}>
          <SourceTrail rec={rec} />
          <span className="truncate" title={statusText}>{statusText}</span>
        </div>
      </div>

      <span className={`pill ${tone.pill}`}>
        {busy && <span className="dot" />}
        {status === 'downloading' && pct !== null ? `${pct}%` : tone.label}
      </span>

      <div className="actions">
        {status === 'completed' && isElectron && (
          <button className="btn btn-sm btn-ghost btn-icon" onClick={openFolder} title="Show in folder">⌕</button>
        )}
        {(status === 'queued' || busy) && (
          <button
            className="btn btn-sm btn-ghost btn-icon btn-danger"
            onClick={() => getController().cancel(item.id)}
            title="Cancel this track"
          >✕</button>
        )}
        {!busy && status !== 'queued' && (
          <button
            className="btn btn-sm btn-ghost btn-icon btn-danger"
            onClick={() => getController().remove(item.id)}
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
